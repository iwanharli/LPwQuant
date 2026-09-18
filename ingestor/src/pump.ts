import { pg } from "./db";
import type { PoolSnapshot } from "./meteora";
import { redis } from "./redis";
import { baseMint } from "./security";
import { apiFetch } from "./rpc";

export const PUMP_KEY = "pump:latest"; // hash: mint -> PumpToken JSON (read by engine)

// Undocumented pump.fun front-end APIs: paths change without notice (several older ones already 404/410), so every
// failure is logged and skipped without affecting other fetchers.
const COIN_URL = "https://frontend-api-v3.pump.fun/coins";
const PAIR_URL = "https://swap-api.pump.fun/v1/pools/pair";
const SOL_MINT = "So11111111111111111111111111111111111111112";
// pump.fun reports native SOL as the System Program id; PumpSwap pools are keyed by the wrapped SOL mint.
const NATIVE_SOL_PLACEHOLDER = "11111111111111111111111111111111";
const TTL_MS = 30 * 60_000;
const REQUEST_GAP_MS = 1_500;
const LOAD_MAX_AGE_HOURS = 24;
const HEADERS = {
  Accept: "application/json",
  Origin: "https://pump.fun",
  "User-Agent": "Mozilla/5.0 (compatible; quant-screener/0.1)",
};

/** pump.fun view of a token launched there: graduation, all-time-high market cap, bans and PumpSwap liquidity. */
export interface PumpToken {
  mint: string;
  fetched_at: number;
  found: boolean; // false: pump.fun has no coin for this mint
  creator: string | null;
  created_ts: number | null;
  complete: boolean | null; // graduated off the bonding curve
  is_banned: boolean;
  nsfw: boolean;
  usd_market_cap: number | null;
  ath_market_cap_usd: number | null;
  ath_ts: number | null;
  pump_swap_pool: string | null;
  pumpswap_liquidity_usd: number | null;
  twitter: string | null;
  website: string | null;
}

interface PumpCoin {
  mint: string;
  creator?: string;
  created_timestamp?: number;
  complete?: boolean;
  is_banned?: boolean;
  nsfw?: boolean;
  usd_market_cap?: number;
  ath_market_cap?: number;
  ath_market_cap_timestamp?: number;
  pump_swap_pool?: string | null;
  quote_mint?: string | null;
  twitter?: string | null;
  website?: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** pump.fun launches: mints ending in "pump", or pools Meteora tags with the pump.fun launchpad. */
export function isPumpToken(pool: PoolSnapshot): boolean {
  return baseMint(pool).endsWith("pump") || pool.launchpad === "pump.fun";
}

export function normalizeCoin(coin: PumpCoin, pumpswapLiquidity: number | null, fetchedAt: number): PumpToken {
  return {
    mint: coin.mint,
    fetched_at: fetchedAt,
    found: true,
    creator: coin.creator ?? null,
    created_ts: num(coin.created_timestamp),
    complete: typeof coin.complete === "boolean" ? coin.complete : null,
    is_banned: !!coin.is_banned,
    nsfw: !!coin.nsfw,
    usd_market_cap: num(coin.usd_market_cap),
    // ath_market_cap is USD: it matches usd_market_cap for tokens trading at their high.
    ath_market_cap_usd: num(coin.ath_market_cap),
    ath_ts: num(coin.ath_market_cap_timestamp),
    pump_swap_pool: coin.pump_swap_pool ?? null,
    pumpswap_liquidity_usd: pumpswapLiquidity,
    twitter: coin.twitter || null,
    website: coin.website || null,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PumpFetcher {
  private readonly cache = new Map<string, PumpToken>();
  private running = false;
  private stopped = false;

  get known(): number {
    return this.cache.size;
  }

  async load(): Promise<void> {
    const { rows } = await pg.query<{ data: PumpToken }>(
      `select data from token_pump where fetched_at > now() - make_interval(hours => $1)`,
      [LOAD_MAX_AGE_HOURS],
    );
    for (const { data } of rows) this.cache.set(data.mint, data);
    if (rows.length > 0) {
      await redis.hset(PUMP_KEY, Object.fromEntries(rows.map(({ data }) => [data.mint, JSON.stringify(data)])));
    }
  }

  enqueue(pools: PoolSnapshot[]): void {
    if (this.running || this.stopped) return;
    const now = Date.now();
    const stale = [...new Set(pools.filter(isPumpToken).map(baseMint))].filter((mint) => {
      const cached = this.cache.get(mint);
      return !cached || now - cached.fetched_at >= TTL_MS;
    });
    if (stale.length > 0) void this.refresh(stale);
  }

  stop(): void {
    this.stopped = true;
  }

  private async get<T>(url: string): Promise<{ status: number; body: T | null }> {
    const res = await apiFetch("pump.fun", "coins", url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: (await res.json()) as T };
  }

  private async refresh(mints: string[]): Promise<void> {
    this.running = true;
    try {
      for (const mint of mints) {
        if (this.stopped) break;
        try {
          const now = Date.now();
          const coin = await this.get<PumpCoin>(`${COIN_URL}/${mint}`);
          if (coin.status === 404 || (coin.body && !coin.body.mint)) {
            await this.save({ ...normalizeCoin({ mint }, null, now), found: false });
          } else if (coin.body) {
            await sleep(REQUEST_GAP_MS);
            const reported = coin.body.quote_mint;
            const quote = !reported || reported === NATIVE_SOL_PLACEHOLDER ? SOL_MINT : reported;
            const pair = await this.get<{ liquidityUSD?: number }[]>(
              `${PAIR_URL}?mintA=${quote}&mintB=${mint}&sort=liquidity`,
            );
            const liquidity = Array.isArray(pair.body) && pair.body.length > 0 ? num(pair.body[0].liquidityUSD) : null;
            await this.save(normalizeCoin(coin.body, liquidity, now));
          } else {
            console.warn(`[pump] ${mint}: HTTP ${coin.status}`);
          }
        } catch (err) {
          console.error(`[pump] ${mint} failed: ${err instanceof Error ? err.message : err}`);
        }
        await sleep(REQUEST_GAP_MS);
      }
    } finally {
      this.running = false;
    }
  }

  private async save(token: PumpToken): Promise<void> {
    this.cache.set(token.mint, token);
    await pg.query(
      `insert into token_pump (mint, fetched_at, data) values ($1, to_timestamp($2::float8 / 1000), $3)
       on conflict (mint) do update set fetched_at = excluded.fetched_at, data = excluded.data`,
      [token.mint, token.fetched_at, JSON.stringify(token)],
    );
    await redis.hset(PUMP_KEY, token.mint, JSON.stringify(token));
  }
}
