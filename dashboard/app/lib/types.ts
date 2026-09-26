export type PlanAction = "enter" | "wait" | "avoid";
export type Tier = "low" | "medium" | "high";
export type Strategy = "spot" | "curve" | "bid_ask";
export type Regime = "ranging" | "mixed" | "trending_up" | "trending_down";

/** Indicators on 30m candles plus latest buy/sell flow (engine/app/indicators.py). */
export type Market = {
  candles?: number;
  last_ts?: number;
  atr_pct?: number | null;
  adx?: number | null;
  plus_di?: number | null;
  minus_di?: number | null;
  choppiness?: number | null;
  rsi?: number | null;
  bb_width_pct?: number | null;
  bb_pct_b?: number | null;
  bb_squeeze?: boolean | null;
  ema_slope_pct?: number | null;
  donchian_low_pct?: number | null;
  donchian_high_pct?: number | null;
  change_1h_pct?: number | null;
  change_24h_pct?: number | null;
  drawdown_pct?: number | null;
  regime?: Regime | null;
  flow_ts?: number | null;
  txns_h1?: number;
  buy_ratio_h1?: number | null;
  buyer_ratio_h1?: number | null;
  buy_ratio_m15?: number | null;
  sell_pressure?: boolean;
};

export type ActivePlan = {
  action: "enter";
  reason: null;
  tier: Tier;
  tier_reason: string;
  regime: Regime | null;
  strategy: Strategy;
  side: "both" | "quote";
  note: string;
  notes: string[];
  range_low_pct: number;
  range_high_pct: number;
  bins: number;
  positions: number;
  size_usd: number;
  size_pct: number;
  size_capped_by_tvl: boolean;
  expected_fee_usd_day: number;
  /** Round-trip cost estimate and fees expected over the cost-gate window, both % of the position. */
  round_trip_cost_pct?: number;
  fee_over_min_hold_pct?: number;
  /** On-chain count of bin arrays the range must create (non-refundable rent); null = unknown. */
  new_bin_arrays?: number | null;
  exit: {
    stop_loss_pct: number;
    out_of_range_minutes: number;
    fee_decay_ratio: number;
    max_hold_hours: number;
    breakout_below_pct: number | null;
    breakout_above_pct: number | null;
  };
};

export type RiskyRange = {
  strategy: Strategy;
  side: "both" | "quote";
  note: string;
  range_low_pct: number;
  range_high_pct: number;
  bins: number;
  positions: number;
  size_usd: number;
  stop_loss_pct: number;
};

export type Plan =
  | {
      action: "avoid" | "wait";
      reason: string;
      tier: null;
      regime?: Regime | null;
      /** Tier of the entry plan the cost gate held back. */
      gated_tier?: Tier;
      round_trip_cost_pct?: number;
      fee_over_min_hold_pct?: number;
      /** A range for entering anyway; null when the token itself is unsafe (can be minted, frozen, rugged). */
      risky?: RiskyRange | null;
    }
  | ActivePlan;

export type Security = {
  score_normalised: number | null;
  rugged: boolean;
  mint_authority: boolean;
  freeze_authority: boolean;
  top10_pct: number | null;
  insiders_detected: number;
  total_holders: number | null;
  lp_locked_pct: number | null;
  transfer_fee_pct?: number | null;
  transfer_fee_mutable?: boolean;
  cluster_pct?: number | null;
  cluster_size?: number | null;
  danger_count: number;
  warn_count: number;
  fetched_at: number;
  risks: string[];
};

/** On-chain liquidity around the active bin, used for the fee share. */
export type BinDepth = {
  age_sec: number;
  window_bins: number;
  scanned_usd?: number | null;
  per_bin_usd: number | null;
  active_bin_usd: number | null;
  avg_nonempty_bin_usd: number | null;
  new_bin_arrays: number | null;
};

/** Jupiter organic score for the base token (ingestor/src/jupiter.ts). */
export type Organic = {
  mint: string;
  fetched_at: number;
  organic_score: number | null;
  organic_label: "high" | "medium" | "low" | string | null;
  organic_buy_usd_24h: number | null;
  organic_sell_usd_24h: number | null;
  buy_usd_24h: number | null;
  sell_usd_24h: number | null;
  organic_buyers_24h: number | null;
  traders_24h: number | null;
  bot_holders_pct: number | null;
  top_holders_pct: number | null;
  liquidity_usd?: number | null;
  verified: boolean;
};

/** pump.fun data for tokens launched there (ingestor/src/pump.ts). */
export type PumpToken = {
  mint: string;
  fetched_at: number;
  found: boolean;
  creator: string | null;
  created_ts: number | null;
  complete: boolean | null;
  is_banned: boolean;
  nsfw: boolean;
  usd_market_cap: number | null;
  ath_market_cap_usd: number | null;
  ath_ts: number | null;
  pump_swap_pool: string | null;
  pumpswap_liquidity_usd: number | null;
  twitter: string | null;
  website: string | null;
};

/** What the paper profile with the best record would do with a pool (engine/app/service.py _best_decision). */
export type BestDecision = {
  key: string;
  label: string;
  enter: boolean;
  reason: string | null;
  /** Fee the pool earns now over what the profile's gate asks for: 1 and above opens. */
  coverage: number | null;
  /** The profile's own return so far, so the page can say why it is the one being followed. */
  return_pct: number;
};

export type PoolRow = {
  best?: BestDecision | null;
  address: string;
  name: string;
  base_symbol: string | null;
  base_mint: string | null;
  bin_step: number;
  base_fee_pct: number;
  dynamic_fee_pct: number;
  price: number;
  tvl: number;
  volume_24h: number;
  fees_24h: number;
  fee_tvl_pct_24h: number;
  fee_tvl_pct_1h_x24: number;
  fee_expected_pct_day: number;
  fee_for_position_pct_day: number;
  /** (base + dynamic fee) / base fee right now; null when base fee is 0. */
  fee_multiple_now: number | null;
  volume_tvl_24h: number;
  change_pct_1h: number | null;
  realized_vol_pct_1h: number | null;
  pool_age_hours: number | null;
  holders: number;
  market_cap: number;
  flags: string[];
  score: number;
  safety: number;
  watched: boolean;
  updated_at: number;
  regime: Regime | null;
  plan: Plan;
  security: Security | null;
  /** Hours since the token itself launched (pump.fun, Jupiter's first pool, or RugCheck's first sighting). */
  token_age_hours?: number | null;
  /** Plain-language signs of a creator's own setup rather than a real market; 2+ make it "sangat mencurigakan". */
  danger?: string[];
  market: Market | null;
  depth: BinDepth | null;
  /** Entry plan before the cost gate (each risk profile applies its own gate); null when there is none. */
  plan_base?: ActivePlan | null;
  insights: Insights | null;
  organic?: Organic | null;
  pump?: PumpToken | null;
};

export type LiveMessage =
  | { type: "snapshot"; updated_at: number | null; pools: PoolRow[] }
  | { type: "update"; pools: PoolRow[] };

export type ConnectionStatus = "connecting" | "live" | "offline";

export type SortKey = keyof Pick<
  PoolRow,
  | "score"
  | "bin_step"
  | "tvl"
  | "volume_24h"
  | "fee_for_position_pct_day"
  | "fee_tvl_pct_24h"
  | "change_pct_1h"
  | "realized_vol_pct_1h"
  | "pool_age_hours"
> | "coverage";

export type TagStats = { count: number; holding_pct: number; netflow_usd: number };

/** GMGN token insights (ingestor/src/gmgn.ts). */
export type Insights = {
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
    boost_ts: number | null;
    ad_ts: number | null;
  } | null;
  flow: { buy_usd_1h: number | null; sell_usd_1h: number | null; buy_usd_24h: number | null; sell_usd_24h: number | null } | null;
  market: { holders: number | null; liquidity_usd: number | null; price: number | null; ath_price: number | null; hot_level: number | null } | null;
  tags: Partial<Record<"bundler" | "sniper" | "smart_degen" | "renowned", TagStats>>;
};

export type UsageItem = {
  provider: string;
  kind: "http" | "http_error" | "ws_subscribe" | "ws_message";
  this_hour: number;
  last_24h: number;
  this_month: number;
  hours_covered: number;
  projected_30d: number | null;
};

export const isActivePlan = (plan: Plan): plan is ActivePlan => plan.action === "enter";

/** A pool's risk tier even when its entry plan is held back (cost gate) or its base plan exists: tiers describe
 * the pool's risk, while plan.tier is null for any non-entry plan. */
export function rowTier(row: Pick<PoolRow, "plan" | "plan_base">): Tier | null {
  const plan = row.plan;
  if (plan.tier) return plan.tier;
  if (plan.action === "wait" && plan.gated_tier) return plan.gated_tier;
  return plan.action === "avoid" ? null : (row.plan_base?.tier ?? null);
}
