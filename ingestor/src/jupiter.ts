import { pg } from "./db";
import type { PoolSnapshot } from "./meteora";
import { redis } from "./redis";
import { baseMint } from "./security";
import { apiFetch } from "./rpc";

export const ORGANIC_KEY = "jupiter:latest"; // hash: mint -> TokenOrganic JSON (read by engine)

const SEARCH_URL = "https://datapi.jup.ag/v1/assets/search";
const BATCH = 100; // the search endpoint accepts 100 comma-separated mints per request
const TTL_MS = 15 * 60_000;
const REQUEST_GAP_MS = 1_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const LOAD_MAX_AGE_HOURS = 24;

/** Jupiter's organic-activity view of a token: how much of its trading looks like real users, not bots/wash. */
export interface TokenOrganic {
  mint: string;
  fetched_at: number;
  organic_score: number | null; // 0-100
  organic_label: string | null; // high | medium | low
  organic_buy_usd_24h: number | null;
  organic_sell_usd_24h: number | null;
  buy_usd_24h: number | null;
  sell_usd_24h: number | null;
  organic_buyers_24h: number | null;
  traders_24h: number | null;
  bot_holders_pct: number | null;
  top_holders_pct: number | null;
  /** Token liquidity across all DEX pools (USD). A single pool reporting far more TVL than this is suspect. */
  liquidity_usd: number | null;
  verified: boolean;
}

interface JupiterAsset {
  id: string;
  organicScore?: number | null;
  organicScoreLabel?: string | null;
  isVerified?: boolean | null;
  liquidity?: number | null;
  stats24h?: {
    buyVolume?: number;
    sellVolume?: number;
    buyOrganicVolume?: number;
    sellOrganicVolume?: number;
    numOrganicBuyers?: number;
    numTraders?: number;
  } | null;
  audit?: { botHoldersPercentage?: number; topHoldersPercentage?: number } | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normalizeAsset(asset: JupiterAsset, fetchedAt: number): TokenOrganic {
  const s = asset.stats24h ?? {};
  return {
    mint: asset.id,
    fetched_at: fetchedAt,
    organic_score: num(asset.organicScore),
    organic_label: asset.organicScoreLabel ?? null,
    organic_buy_usd_24h: num(s.buyOrganicVolume),
    organic_sell_usd_24h: num(s.sellOrganicVolume),
    buy_usd_24h: num(s.buyVolume),
    sell_usd_24h: num(s.sellVolume),
    organic_buyers_24h: num(s.numOrganicBuyers),
    traders_24h: num(s.numTraders),
    bot_holders_pct: num(asset.audit?.botHoldersPercentage),
    top_holders_pct: num(asset.audit?.topHoldersPercentage),
    liquidity_usd: num(asset.liquidity),
    verified: !!asset.isVerified,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keeps Jupiter organic scores fresh for the base token of every tracked pool, 100 mints per request. */
export class JupiterFetcher {
  private readonly cache = new Map<string, TokenOrganic>();
  private running = false;
  private stopped = false;

  get known(): number {
    return this.cache.size;
  }

  async load(): Promise<void> {
    const { rows } = await pg.query<{ data: TokenOrganic }>(
      `select data from token_organic where fetched_at > now() - make_interval(hours => $1)`,
      [LOAD_MAX_AGE_HOURS],
    );
    for (const { data } of rows) this.cache.set(data.mint, data);
    if (rows.length > 0) {
      await redis.hset(ORGANIC_KEY, Object.fromEntries(rows.map(({ data }) => [data.mint, JSON.stringify(data)])));
    }
  }

  /** Refresh stale or missing base mints in the background; a refresh already running is left to finish. */
  enqueue(pools: PoolSnapshot[]): void {
    if (this.running || this.stopped) return;
    const now = Date.now();
    const stale = [...new Set(pools.map(baseMint))].filter((mint) => {
      const cached = this.cache.get(mint);
      return !cached || now - cached.fetched_at >= TTL_MS;
    });
    if (stale.length === 0) return;
    void this.refresh(stale);
  }

  stop(): void {
    this.stopped = true;
  }

  private async refresh(mints: string[]): Promise<void> {
    this.running = true;
    try {
      for (let i = 0; i < mints.length && !this.stopped; i += BATCH) {
        const chunk = mints.slice(i, i + BATCH);
        try {
          const res = await apiFetch("jupiter", "assets/search", `${SEARCH_URL}?query=${chunk.join(",")}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(30_000),
          });
          if (res.status === 429) {
            console.warn("[jupiter] rate limited, backing off");
            await sleep(RATE_LIMIT_BACKOFF_MS);
            i -= BATCH; // retry this chunk
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const now = Date.now();
          const wanted = new Set(chunk);
          const assets = ((await res.json()) as JupiterAsset[]).filter((a) => wanted.has(a.id));
          await this.save(assets.map((a) => normalizeAsset(a, now)));
        } catch (err) {
          // Left stale; the next poll picks these mints up again.
          console.error(`[jupiter] batch of ${chunk.length} failed: ${err instanceof Error ? err.message : err}`);
        }
        await sleep(REQUEST_GAP_MS);
      }
    } finally {
      this.running = false;
    }
  }

  private async save(items: TokenOrganic[]): Promise<void> {
    if (items.length === 0) return;
    for (const item of items) this.cache.set(item.mint, item);
    await pg.query(
      `insert into token_organic (mint, fetched_at, data)
       select r.mint, to_timestamp((r.data->>'fetched_at')::float8 / 1000), r.data
       from jsonb_to_recordset($1::jsonb) as r(mint text, data jsonb)
       on conflict (mint) do update set fetched_at = excluded.fetched_at, data = excluded.data`,
      [JSON.stringify(items.map((item) => ({ mint: item.mint, data: item })))],
    );
    await redis.hset(ORGANIC_KEY, Object.fromEntries(items.map((item) => [item.mint, JSON.stringify(item)])));
  }
}
