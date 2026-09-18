import { randomUUID } from "node:crypto";
import { config } from "./config";
import { pg } from "./db";
import { sleep } from "./market";
import type { PoolSnapshot } from "./meteora";
import { redis } from "./redis";
import { baseMint } from "./security";
import { apiFetch } from "./rpc";

const HOST = "https://openapi.gmgn.ai";
export const GMGN_KEY = "gmgn:latest"; // hash: token mint -> TokenInsights JSON (read by engine)

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/** Wallet tags pulled from top holders: bundlers/snipers (dump risk), smart money and KOLs (signal). */
export const HOLDER_TAGS = ["bundler", "sniper", "smart_degen", "renowned"] as const;
type HolderTag = (typeof HOLDER_TAGS)[number];

// Free plan advertises weight 5/s, but weight-5 calls every 2.5s (~2 weight/s) already left no headroom
// for a single extra request. Keep ~0.8 weight/s: weight-1 every 1.5s, weight-5 every 6s.
const INFO_GAP_MS = 1_500;
const HOLDERS_GAP_MS = 6_000;
const BAN_BUFFER_MS = 2_000;
const LOAD_MAX_AGE_HOURS = 24;

export class GmgnRateLimitedError extends Error {
  constructor(readonly resetAtMs: number) {
    super("gmgn rate limited");
  }
}

function resetAtMs(header: string | null): number {
  const v = Number(header);
  if (!Number.isFinite(v) || v <= 0) return Date.now() + 60_000;
  if (v > 1e12) return v; // ms timestamp
  if (v > 1e9) return v * 1000; // unix seconds
  return Date.now() + v * 1000; // seconds from now
}

/** Read-only ("exist auth") request: API key + timestamp + client_id, no signature. */
export async function gmgnGet<T>(subPath: string, params: Record<string, string | number>): Promise<T> {
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: randomUUID(),
  });
  const res = await apiFetch("gmgn", subPath, `${HOST}${subPath}?${query}`, {
    headers: { "X-APIKEY": config.gmgnApiKey, "Content-Type": "application/json", "User-Agent": "quant-ingestor" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: { code: number; error?: string; message?: string; data?: T };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: non-JSON response`);
  }
  if (body.code !== 0) {
    if (res.status === 429 || body.error === "RATE_LIMIT_EXCEEDED" || body.error === "RATE_LIMIT_BANNED") {
      throw new GmgnRateLimitedError(resetAtMs(res.headers.get("x-ratelimit-reset")));
    }
    throw new Error(`HTTP ${res.status} ${body.error ?? body.code}: ${(body.message ?? "").slice(0, 160)}`);
  }
  return body.data as T;
}

interface GmgnTokenInfo {
  holder_count?: number;
  liquidity?: number;
  circulating_supply?: number;
  ath_price?: number;
  price?: {
    price?: number;
    buy_volume_1h?: number;
    sell_volume_1h?: number;
    buy_volume_24h?: number;
    sell_volume_24h?: number;
    hot_level?: number;
  };
  dev?: {
    creator_address?: string;
    creator_token_balance?: number;
    creator_token_status?: string;
    creator_open_count?: number;
    fund_from?: string;
    cto_flag?: number;
    dexscr_boost_ts?: number;
    dexscr_ad_ts?: number;
  };
}

interface GmgnHolder {
  balance?: number;
  amount_percentage?: number; // fraction of supply
  netflow_usd?: number;
}

export interface TagStats {
  count: number;
  holding_pct: number;
  netflow_usd: number;
}

export interface TokenInsights {
  mint: string;
  info_at: number | null;
  holders_at: number | null;
  dev: {
    creator: string | null;
    launches: number | null;
    status: string | null;
    hold_pct: number | null;
    fund_from: string | null;
    cto: boolean;
    boost_ts: number | null; // unix seconds
    ad_ts: number | null;
  } | null;
  flow: { buy_usd_1h: number | null; sell_usd_1h: number | null; buy_usd_24h: number | null; sell_usd_24h: number | null } | null;
  market: { holders: number | null; liquidity_usd: number | null; price: number | null; ath_price: number | null; hot_level: number | null } | null;
  /** Aggregated over the top 100 holders carrying each tag. */
  tags: Partial<Record<HolderTag, TagStats>>;
}

/** GMGN sends some numbers (large balances/supplies) as strings, so accept numeric strings too. */
const n = (v: unknown): number | null => {
  const num = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
};
const ts = (v: unknown): number | null => {
  const num = n(v);
  return num != null && num > 0 ? num : null;
};

export function normalizeInfo(info: GmgnTokenInfo): Pick<TokenInsights, "dev" | "flow" | "market"> {
  const dev = info.dev ?? {};
  const supply = n(info.circulating_supply);
  const devBalance = n(dev.creator_token_balance);
  return {
    dev: {
      creator: dev.creator_address || null,
      launches: n(dev.creator_open_count),
      status: dev.creator_token_status || null,
      hold_pct: supply && devBalance != null ? (devBalance / supply) * 100 : null,
      fund_from: dev.fund_from || null,
      cto: dev.cto_flag === 1,
      boost_ts: ts(dev.dexscr_boost_ts),
      ad_ts: ts(dev.dexscr_ad_ts),
    },
    flow: {
      buy_usd_1h: n(info.price?.buy_volume_1h),
      sell_usd_1h: n(info.price?.sell_volume_1h),
      buy_usd_24h: n(info.price?.buy_volume_24h),
      sell_usd_24h: n(info.price?.sell_volume_24h),
    },
    market: {
      holders: n(info.holder_count),
      liquidity_usd: n(info.liquidity),
      price: n(info.price?.price),
      ath_price: n(info.ath_price),
      hot_level: n(info.price?.hot_level),
    },
  };
}

export function aggregateHolders(list: GmgnHolder[]): TagStats {
  const holding = list.filter((h) => (h.balance ?? 0) > 0);
  return {
    count: holding.length,
    holding_pct: holding.reduce((sum, h) => sum + (h.amount_percentage ?? 0), 0) * 100,
    netflow_usd: list.reduce((sum, h) => sum + (h.netflow_usd ?? 0), 0),
  };
}

/**
 * Keeps GMGN token insights fresh for tracked pools: token info for every base token, tagged top
 * holders for the highest-volume ones. Strictly sequential with fixed gaps; on a rate-limit response it
 * sends nothing until the server's reset time (requests during a ban extend it).
 */
export class GmgnFetcher {
  private readonly insights = new Map<string, TokenInsights>();
  private running = false;
  private stopped = false;

  get known(): number {
    return this.insights.size;
  }

  async load(): Promise<void> {
    const { rows } = await pg.query<{ data: TokenInsights }>(
      `select data from token_insights where fetched_at > now() - make_interval(hours => $1)`,
      [LOAD_MAX_AGE_HOURS],
    );
    for (const { data } of rows) this.insights.set(data.mint, data);
    if (rows.length > 0) {
      await redis.hset(GMGN_KEY, Object.fromEntries(rows.map(({ data }) => [data.mint, JSON.stringify(data)])));
    }
  }

  maybeRefresh(pools: PoolSnapshot[]): void {
    if (this.running || this.stopped) return;
    void this.run(pools);
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(pools: PoolSnapshot[]): Promise<void> {
    this.running = true;
    try {
      const mints = [...new Set(pools.map(baseMint))].filter((m) => !QUOTE_MINTS.has(m));

      for (const mint of mints) {
        if (this.stopped) return;
        const current = this.insights.get(mint);
        if (current?.info_at && Date.now() - current.info_at < config.gmgnInfoRefreshMs) continue;
        const info = await this.request<GmgnTokenInfo>("/v1/token/info", { chain: "sol", address: mint }, INFO_GAP_MS);
        if (info) await this.save({ ...this.base(mint), ...normalizeInfo(info), info_at: Date.now() });
      }

      for (const mint of mints.slice(0, config.gmgnHoldersTopN)) {
        if (this.stopped) return;
        const current = this.insights.get(mint);
        if (current?.holders_at && Date.now() - current.holders_at < config.gmgnHoldersRefreshMs) continue;
        const tags: Partial<Record<HolderTag, TagStats>> = {};
        let complete = true;
        for (const tag of HOLDER_TAGS) {
          const data = await this.request<{ list?: GmgnHolder[] }>(
            "/v1/market/token_top_holders",
            { chain: "sol", address: mint, tag, limit: 100, order_by: "amount_percentage", direction: "desc" },
            HOLDERS_GAP_MS,
          );
          if (!data) {
            complete = false;
            break;
          }
          tags[tag] = aggregateHolders(data.list ?? []);
        }
        if (complete) await this.save({ ...this.base(mint), tags, holders_at: Date.now() });
      }
    } catch (err) {
      console.error(`[gmgn] refresh failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }

  private base(mint: string): TokenInsights {
    return this.insights.get(mint) ?? { mint, info_at: null, holders_at: null, dev: null, flow: null, market: null, tags: {} };
  }

  private async request<T>(subPath: string, params: Record<string, string | number>, gapMs: number): Promise<T | null> {
    while (!this.stopped) {
      try {
        const data = await gmgnGet<T>(subPath, params);
        await sleep(gapMs);
        return data;
      } catch (err) {
        if (err instanceof GmgnRateLimitedError) {
          const wait = Math.max(err.resetAtMs - Date.now(), 0) + BAN_BUFFER_MS;
          console.warn(`[gmgn] rate limited, pausing ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          continue;
        }
        console.error(`[gmgn] ${subPath} ${params.address}: ${err instanceof Error ? err.message : err}`);
        await sleep(gapMs);
        return null;
      }
    }
    return null;
  }

  private async save(insight: TokenInsights): Promise<void> {
    this.insights.set(insight.mint, insight);
    const json = JSON.stringify(insight);
    await pg.query(
      `insert into token_insights (mint, fetched_at, data) values ($1, now(), $2)
       on conflict (mint) do update set fetched_at = excluded.fetched_at, data = excluded.data`,
      [insight.mint, json],
    );
    await pg.query(`insert into token_insight_snapshots (ts, mint, data) values (now(), $1, $2)`, [insight.mint, json]);
    await redis.hset(GMGN_KEY, insight.mint, json);
  }
}
