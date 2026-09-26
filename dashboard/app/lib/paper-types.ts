import type { Regime, Strategy, Tier } from "./types";

export type TradeStats = {
  trades: number;
  win_rate_pct?: number;
  mean_return_pct?: number;
  median_return_pct?: number;
  p10_return_pct?: number;
  worst_return_pct?: number;
  mean_fee_pct?: number;
  mean_il_vs_hodl_pct?: number;
  mean_hold_hours?: number;
  exit_reasons?: Record<string, number>;
  ci_low?: number | null;
  ci_high?: number | null;
  mean_cost_pct?: number;
  mean_gross_return_pct?: number;
};

export type PaperCosts = {
  enabled: boolean;
  tx_cost_sol: number;
  txs_per_position: number;
  position_rent_sol: number;
  new_bin_array_share: number;
  impact_multiplier: number;
  closed_cost_usd: number;
  open_cost_usd: number;
  rent_locked_sol: number;
};

export type ProfileSettings = {
  tiers: Tier[];
  max_open_per_tier: number;
  size_mult: number;
  min_fee_cost_ratio: number | null;
  fee_gate_hours: number | null;
  min_hold_hours: number | null;
  stop_loss_mult: number;
  max_drawdown_pct: number | null;
  position_floor_usd?: number;
  max_atr_pct?: number | null;
  plan_variant?: string;
};

export type ProfileInfo = { key: string; label: string; description: string; settings: ProfileSettings };

/** Headline numbers per risk profile from /api/paper/profiles. */
export type ProfileSummary = ProfileInfo & {
  start_equity_usd: number;
  equity_usd: number;
  realized_usd: number;
  unrealized_usd: number;
  open_count: number;
  closed_count: number;
  costs_usd: number;
  max_drawdown_pct: number;
  entries_paused: boolean;
  started_at: number | null;
  overall: TradeStats;
  /** Pre-registered decision rule (engine/app/paper.py MIN_TRADES_FOR_VERDICT). */
  verdict?: { status: "collecting" | "profitable" | "losing" | "inconclusive"; trades: number; trades_needed: number };
};

export type PaperSummary = {
  fees_usd?: number;
  avg_capital_usd?: number | null;
  enabled: boolean;
  profile: ProfileInfo;
  config: { max_open_per_tier: number; tiers: Tier[]; cooldown_hours: number };
  costs: PaperCosts;
  risk: {
    min_position_usd: number;
    max_drawdown_pct: number | null;
    peak_equity_usd: number;
    drawdown_pct: number;
    entries_paused: boolean;
    resume_at?: number | null;
    pause_hours?: number;
  };
  started_at: number | null;
  start_equity_usd: number;
  equity_usd: number;
  realized_usd: number;
  unrealized_usd: number;
  open_count: number;
  closed_count: number;
  overall: TradeStats;
  by_tier: Record<Tier, TradeStats>;
  by_strategy: Record<string, TradeStats>;
};

export type PaperPosition = {
  id: number;
  status: "open" | "closed";
  address: string;
  name: string;
  quote_symbol: string | null;
  tier: Tier;
  strategy: Strategy;
  regime: Regime | null;
  score: number | null;
  bin_step: number;
  entry_ts: number;
  entry_price: number;
  min_price: number;
  max_price: number;
  range_low_pct: number;
  range_high_pct: number;
  capital_usd: number;
  last_price: number;
  in_range: boolean | null;
  pnl_pct: number;
  gross_pnl_pct: number | null;
  cost_pct: number;
  positions: number;
  rent_sol: number;
  fee_pct: number;
  il_pct: number;
  hold_hours: number;
  exit_ts: number | null;
  exit_price: number | null;
  exit_reason: string | null;
  flags: string[];
  base_mint?: string | null;
};

export type EquityPoint = { ts: number; equity_usd: number; open_count: number };

export const EXIT_REASON_LABELS: Record<string, string> = {
  stop_loss: "Stop loss",
  out_of_range: "Keluar range",
  breakout: "Breakout",
  fee_decay: "Fee melemah",
  max_hold: "Batas waktu",
  delisted: "Pool tidak dipantau lagi",
  profile_retired: "Profil dihentikan",
};

/** Line colour per risk profile, one fixed hue per profile so a profile keeps its colour as profiles come and
 * go (validated on the dark panel with scripts/validate_palette.js, and kept clear of the green/red used for
 * gains and losses). "agresif" no longer trades but keeps its violet, so its history never changes colour. */
/** One clearly different hue per profile. The four that run now (Moderat, Satu Sisi and its two variants) get the
 * most separated ones -- blue, yellow, magenta, cyan -- and none is green, red or the orange accent, which already
 * mean profit, loss and "selected". */
export const PROFILE_COLORS: Record<string, string> = {
  moderat: "#4a9eff",
  satu_sisi: "#f2c744",
  satu_sisi_volatil: "#e05ea8",
  satu_sisi_sering: "#2ec4b6",
  konservatif: "#9b8cff",
  tenang: "#8fd16a",
  bolak_balik: "#c9a27a",
  tinggi_tenang: "#ff8fb1",
  agresif: "#b0b8c4",
};
