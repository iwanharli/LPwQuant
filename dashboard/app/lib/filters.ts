import type { PoolRow } from "./types";

/** Min/max pair; null means "not set". */
export type Range = { min: number | null; max: number | null };

export type Filters = {
  atr: Range;
  marketCap: Range;
  holders: Range;
  top10: Range;
  organic: Range;
  poolAge: Range;
  volume: Range;
  fees: Range;
  feeTvl: Range;
  tvl: Range;
  baseFee: Range;
  verified: boolean;
  newListing: boolean;
  lowConcentration: boolean;
  noInsiders: boolean;
  lpLocked: boolean;
};

export const RANGE_KEYS = [
  "atr", "marketCap", "holders", "top10", "organic", "poolAge", "volume", "fees", "feeTvl", "tvl", "baseFee",
] as const;
export const TOGGLE_KEYS = ["verified", "newListing", "lowConcentration", "noInsiders", "lpLocked"] as const;

export const NEW_LISTING_HOURS = 24;
export const CONCENTRATION_MAX_PCT = 30;
export const LP_LOCKED_MIN_PCT = 50;

export function emptyFilters(): Filters {
  const r = () => ({ min: null, max: null });
  return {
    atr: r(), marketCap: r(), holders: r(), top10: r(), organic: r(), poolAge: r(),
    volume: r(), fees: r(), feeTvl: r(), tvl: r(), baseFee: r(),
    verified: false, newListing: false, lowConcentration: false, noInsiders: false, lpLocked: false,
  };
}


/** Starting point for LP, from what this project actually measured rather than round numbers.
 *
 * ATR <= 5%: impermanent loss tracks volatility hard (backtested IL -0.17% under 2% ATR against -2.62% above
 * 10%), and the two worst buckets are the ones this cuts. 2% scored better still, but on 18 closed trades that
 * is too tight to impose as a default.
 * Top 10 holders <= 30%: the only flag that survived a pool-clustered bootstrap on both metrics (mean -1.30pp
 * [-2.48, -0.27], odds of a higher price -6.44pp [-13.24, -0.21]).
 * TVL >= $25k: price impact scales with 1/TVL, and closed trades below 25k averaged -2.71%.
 *
 * Everything else is left open: there is no measurement here to justify a threshold, and a made-up one would
 * read as a recommendation.
 */
export function defaultFilters(): Filters {
  const f = emptyFilters();
  f.atr.max = 5;
  f.top10.max = 30;
  f.tvl.min = 25_000;
  return f;
}

/** A set range cannot judge a value the pool does not report, so those pools drop out rather than slip through. */
function inRange(value: number | null | undefined, r: Range): boolean {
  if (r.min === null && r.max === null) return true;
  if (value === null || value === undefined || Number.isNaN(value)) return false;
  if (r.min !== null && value < r.min) return false;
  if (r.max !== null && value > r.max) return false;
  return true;
}

export function matchesFilters(p: PoolRow, f: Filters): boolean {
  if (!inRange(p.market?.atr_pct ?? null, f.atr)) return false;
  if (!inRange(p.market_cap, f.marketCap)) return false;
  if (!inRange(p.holders, f.holders)) return false;
  if (!inRange(p.security?.top10_pct ?? p.organic?.top_holders_pct ?? null, f.top10)) return false;
  if (!inRange(p.organic?.organic_score ?? null, f.organic)) return false;
  if (!inRange(p.pool_age_hours, f.poolAge)) return false;
  if (!inRange(p.volume_24h, f.volume)) return false;
  if (!inRange(p.fees_24h, f.fees)) return false;
  if (!inRange(p.fee_tvl_pct_24h, f.feeTvl)) return false;
  if (!inRange(p.tvl, f.tvl)) return false;
  if (!inRange(p.base_fee_pct, f.baseFee)) return false;

  if (f.verified && p.organic?.verified !== true) return false;
  if (f.newListing && !(p.pool_age_hours !== null && p.pool_age_hours <= NEW_LISTING_HOURS)) return false;
  if (f.lowConcentration) {
    const top10 = p.security?.top10_pct ?? p.organic?.top_holders_pct ?? null;
    if (top10 === null || top10 > CONCENTRATION_MAX_PCT) return false;
  }
  if (f.noInsiders && (p.security?.insiders_detected ?? 1) !== 0) return false;
  if (f.lpLocked && (p.security?.lp_locked_pct ?? 0) < LP_LOCKED_MIN_PCT) return false;
  return true;
}

export function activeFilterCount(f: Filters): number {
  let n = 0;
  for (const k of RANGE_KEYS) {
    if (f[k].min !== null) n += 1;
    if (f[k].max !== null) n += 1;
  }
  for (const k of TOGGLE_KEYS) if (f[k]) n += 1;
  return n;
}

/** Saved filter combinations. Browser-only and per-device: localStorage can throw (private windows, blocked
 * site data), so every access is guarded and the panel keeps working without presets. */
export type Preset = { name: string; filters: Filters };

const PRESET_KEY = "quant.filter.presets.v1";
export const MAX_PRESETS = 10;

export function loadPresets(): Preset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PRESET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is Preset => !!p && typeof p.name === "string" && !!p.filters)
      .map((p) => ({ name: p.name, filters: { ...emptyFilters(), ...p.filters } }))
      .slice(0, MAX_PRESETS);
  } catch {
    return [];
  }
}

function writePresets(presets: Preset[]): Preset[] {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    } catch {
      /* storage unavailable: presets stay in memory for this session only */
    }
  }
  return presets;
}

export function savePreset(name: string, filters: Filters): Preset[] {
  const clean = name.trim().slice(0, 40);
  if (!clean) return loadPresets();
  const rest = loadPresets().filter((p) => p.name !== clean);
  return writePresets([{ name: clean, filters }, ...rest].slice(0, MAX_PRESETS));
}

export function deletePreset(name: string): Preset[] {
  return writePresets(loadPresets().filter((p) => p.name !== name));
}
