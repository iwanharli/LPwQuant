import { config } from "./config";
import { pg } from "./db";
import type { PoolSnapshot } from "./meteora";
import { redis } from "./redis";
import { baseMint } from "./security";
import { apiFetch } from "./rpc";

export const CANDLE_TIMEFRAME = "30m";
export const CANDLE_MS = 30 * 60_000;
/** The API rejects wider ranges for 30m candles (48h accepted, 72h not). */
export const CANDLE_WINDOW_MS = 48 * 3_600_000 - 60_000;
const CANDLE_REFRESH_MS = 10 * 60_000;
const CANDLE_REQUEST_GAP_MS = 2_000;

export const FLOW_KEY = "flow:latest"; // hash: pool address -> PoolFlow JSON (read by engine)
const FLOW_REFRESH_MS = 2 * 60_000;
const FLOW_BATCH = 30; // GeckoTerminal maximum per multi request
const FLOW_REQUEST_GAP_MS = 2_500; // public API allows ~30 calls/min
const GECKO_MULTI_URL = "https://api.geckoterminal.com/api/v2/networks/solana/pools/multi";

const RATE_LIMIT_BACKOFF_MS = 60_000;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimitedError extends Error {}

export interface Candle {
  ts: number; // open time, ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchCandles(address: string, startMs: number, endMs: number): Promise<Candle[]> {
  const url =
    `${config.meteoraApi}/pools/${address}/ohlcv?timeframe=${CANDLE_TIMEFRAME}` +
    `&start_time=${Math.floor(startMs / 1000)}&end_time=${Math.floor(endMs / 1000)}`;
  const res = await apiFetch("meteora", "ohlcv", url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) throw new RateLimitedError("meteora ohlcv rate limited");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const body = (await res.json()) as {
    data?: { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[];
  };
  return (body.data ?? []).map((c) => ({
    ts: c.timestamp * 1000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

export async function saveCandles(address: string, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;
  // The newest candle is still forming, so re-fetched candles overwrite older copies.
  await pg.query(
    `insert into candles (address, timeframe, ts, open, high, low, close, volume)
     select $1, $2, to_timestamp(ts::float8 / 1000), open, high, low, close, volume
     from jsonb_to_recordset($3::jsonb) as r(ts bigint, open float8, high float8, low float8, close float8, volume float8)
     on conflict (address, timeframe, ts) do update set
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume`,
    [address, CANDLE_TIMEFRAME, JSON.stringify(candles)],
  );
}

/** Background queue keeping ~48h of 30m candles fresh for every tracked pool. */
export class CandleFetcher {
  private readonly lastFetched = new Map<string, number>();
  private readonly latestCandle = new Map<string, number>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  private stopped = false;

  get tracked(): number {
    return this.latestCandle.size;
  }

  get pending(): number {
    return this.queue.length;
  }

  async load(): Promise<void> {
    const { rows } = await pg.query<{ address: string; latest: string }>(
      `select address, (extract(epoch from max(ts)) * 1000)::bigint as latest
       from candles where timeframe = $1 group by address`,
      [CANDLE_TIMEFRAME],
    );
    for (const r of rows) this.latestCandle.set(r.address, Number(r.latest));
  }

  enqueue(pools: PoolSnapshot[]): void {
    const now = Date.now();
    for (const pool of pools) {
      if (this.queued.has(pool.address) || now - (this.lastFetched.get(pool.address) ?? 0) < CANDLE_REFRESH_MS) continue;
      this.queue.push(pool.address);
      this.queued.add(pool.address);
    }
    if (!this.running) void this.drain();
  }

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (!this.stopped && this.queue.length > 0) {
      const address = this.queue[0];
      const now = Date.now();
      const latest = this.latestCandle.get(address);
      // Incremental: re-fetch the last two candles (the newest was still forming), else a full window.
      const start = latest ? Math.max(latest - 2 * CANDLE_MS, now - CANDLE_WINDOW_MS) : now - CANDLE_WINDOW_MS;
      try {
        const candles = await fetchCandles(address, start, now);
        await saveCandles(address, candles);
        if (candles.length > 0) this.latestCandle.set(address, candles[candles.length - 1].ts);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          console.warn("[candles] rate limited, backing off");
          await sleep(RATE_LIMIT_BACKOFF_MS);
          continue;
        }
        console.error(`[candles] ${address} failed: ${err instanceof Error ? err.message : err}`);
      }
      this.lastFetched.set(address, now);
      this.queue.shift();
      this.queued.delete(address);
      await sleep(CANDLE_REQUEST_GAP_MS);
    }
    this.running = false;
  }
}

interface GeckoTxns {
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
}

interface GeckoPool {
  attributes: {
    address: string;
    transactions?: Record<string, GeckoTxns>;
    volume_usd?: Record<string, string | null>;
  };
  relationships?: { base_token?: { data?: { id?: string } } };
}

export interface FlowWindow extends GeckoTxns {
  volume_usd: number | null;
}

export interface PoolFlow {
  address: string;
  ts: number;
  /** GeckoTerminal's base token differed from ours, so buy/sell sides were swapped. */
  flipped: boolean;
  windows: Record<string, FlowWindow>;
}

export function normalizeFlow(pool: GeckoPool, ourBaseMint: string | undefined, ts: number): PoolFlow {
  const geckoBase = pool.relationships?.base_token?.data?.id?.split("_").pop();
  const flipped = !!ourBaseMint && !!geckoBase && geckoBase !== ourBaseMint;
  const windows: Record<string, FlowWindow> = {};
  for (const [window, t] of Object.entries(pool.attributes.transactions ?? {})) {
    const volume = Number(pool.attributes.volume_usd?.[window]);
    windows[window] = {
      buys: flipped ? t.sells : t.buys,
      sells: flipped ? t.buys : t.sells,
      buyers: flipped ? t.sellers : t.buyers,
      sellers: flipped ? t.buyers : t.sellers,
      volume_usd: Number.isFinite(volume) ? volume : null,
    };
  }
  return { address: pool.attributes.address, ts, flipped, windows };
}

/** Periodic buy/sell flow snapshot for all tracked pools. */
export class FlowFetcher {
  private lastRun = 0;
  private running = false;
  lastCount = 0;

  maybeRefresh(pools: PoolSnapshot[]): void {
    if (this.running || Date.now() - this.lastRun < FLOW_REFRESH_MS) return;
    this.lastRun = Date.now();
    void this.refresh(pools);
  }

  private async refresh(pools: PoolSnapshot[]): Promise<void> {
    this.running = true;
    const bases = new Map(pools.map((p) => [p.address, baseMint(p)]));
    const addresses = [...bases.keys()];
    let saved = 0;
    try {
      for (let i = 0; i < addresses.length; i += FLOW_BATCH) {
        const chunk = addresses.slice(i, i + FLOW_BATCH);
        const res = await apiFetch("geckoterminal", "pools/multi", `${GECKO_MULTI_URL}/${chunk.join(",")}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429) {
          console.warn("[flow] geckoterminal rate limited, skipping rest of this cycle");
          break;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: GeckoPool[] };
        const now = Date.now();
        const flows = (body.data ?? []).map((p) => normalizeFlow(p, bases.get(p.attributes.address), now));
        await saveFlows(flows);
        saved += flows.length;
        await sleep(FLOW_REQUEST_GAP_MS);
      }
    } catch (err) {
      console.error(`[flow] refresh failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.lastCount = saved;
      this.running = false;
    }
  }
}

async function saveFlows(flows: PoolFlow[]): Promise<void> {
  if (flows.length === 0) return;
  await pg.query(
    `insert into pool_flow (ts, address, data)
     select to_timestamp((r.data->>'ts')::float8 / 1000), r.data->>'address', r.data
     from jsonb_array_elements($1::jsonb) as r(data)`,
    [JSON.stringify(flows)],
  );
  await redis.hset(FLOW_KEY, Object.fromEntries(flows.map((f) => [f.address, JSON.stringify(f)])));
}
