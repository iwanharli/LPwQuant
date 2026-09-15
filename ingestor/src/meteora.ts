import { config } from "./config";

export type Window = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";
export type Windowed = Record<Window, number>;

interface ApiToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  is_verified: boolean;
  holders: number | null;
  freeze_authority_disabled: boolean;
  price: number | null;
  market_cap: number | null;
}

interface ApiPool {
  address: string;
  name: string;
  token_x: ApiToken;
  token_y: ApiToken;
  created_at: number | null;
  pool_config: { bin_step: number; base_fee_pct: number; max_fee_pct: number };
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  volume: Windowed;
  fees: Windowed;
  fee_tvl_ratio: Windowed; // already a percentage
  is_blacklisted: boolean;
  launchpad: string;
  tags: string[];
  cumulative_metrics?: { volume: number; fees: number };
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  verified: boolean;
  holders: number | null;
  freeze_disabled: boolean;
  price_usd: number | null;
  market_cap: number | null;
}

/** Normalized pool record shared with the engine via Redis (snake_case on purpose). */
export interface PoolSnapshot {
  ts: number;
  address: string;
  name: string;
  bin_step: number;
  base_fee_pct: number;
  dynamic_fee_pct: number;
  pool_created_at: number | null;
  price: number;
  tvl: number;
  volume: Windowed;
  fees: Windowed;
  fee_tvl_pct: Windowed;
  launchpad: string;
  tags: string[];
  token_x: TokenInfo;
  token_y: TokenInfo;
}

function toToken(t: ApiToken): TokenInfo {
  return {
    mint: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    verified: t.is_verified,
    holders: t.holders,
    freeze_disabled: t.freeze_authority_disabled,
    price_usd: t.price,
    market_cap: t.market_cap,
  };
}

function toSnapshot(p: ApiPool, ts: number): PoolSnapshot {
  return {
    ts,
    address: p.address,
    name: p.name,
    bin_step: p.pool_config.bin_step,
    base_fee_pct: p.pool_config.base_fee_pct,
    dynamic_fee_pct: p.dynamic_fee_pct,
    pool_created_at: p.created_at || null,
    price: p.current_price,
    tvl: p.tvl,
    volume: p.volume,
    fees: p.fees,
    fee_tvl_pct: p.fee_tvl_ratio,
    launchpad: p.launchpad,
    tags: p.tags,
    token_x: toToken(p.token_x),
    token_y: toToken(p.token_y),
  };
}

/** One pool by address, regardless of the screener's volume/TVL filters (e.g. pools with open paper positions). */
export async function fetchPool(address: string): Promise<PoolSnapshot | null> {
  const res = await fetch(`${config.meteoraApi}/pools/${address}`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Meteora API ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return toSnapshot((await res.json()) as ApiPool, Date.now());
}

export interface PoolPage {
  pages: number;
  pools: { snapshot: PoolSnapshot; cumulativeVolume: number; blacklisted: boolean }[];
}

/** One raw page of the full pool list (used by backfill to find pools regardless of current activity). */
export async function fetchPoolPage(page: number, pageSize = 1000): Promise<PoolPage> {
  const url = `${config.meteoraApi}/pools?page=${page}&page_size=${pageSize}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Meteora API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { pages: number; data: ApiPool[] };
  const ts = Date.now();
  return {
    pages: body.pages,
    pools: body.data.map((p) => ({
      snapshot: toSnapshot(p, ts),
      cumulativeVolume: p.cumulative_metrics?.volume ?? 0,
      blacklisted: p.is_blacklisted,
    })),
  };
}

/** Top pools by 24h volume that pass the TVL/volume floor. */
export async function fetchPools(): Promise<PoolSnapshot[]> {
  const url = `${config.meteoraApi}/pools?page=1&page_size=${config.fetchLimit}&sort_by=volume_24h:desc`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Meteora API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data: ApiPool[] };
  const ts = Date.now();
  return body.data
    .filter((p) => !p.is_blacklisted && p.tvl >= config.minTvl && p.volume["24h"] >= config.minVolume24h)
    .sort((a, b) => b.volume["24h"] - a.volume["24h"])
    .slice(0, config.poolLimit)
    .map((p) => toSnapshot(p, ts));
}
