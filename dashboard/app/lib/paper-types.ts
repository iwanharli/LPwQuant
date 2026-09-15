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

export type PaperSummary = {
  enabled: boolean;
  config: { max_open_per_tier: number; tiers: Tier[]; cooldown_hours: number };
  costs: PaperCosts;
  risk: {
    min_position_usd: number;
    max_drawdown_pct: number | null;
    peak_equity_usd: number;
    drawdown_pct: number;
    entries_paused: boolean;
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
};

export type EquityPoint = { ts: number; equity_usd: number; open_count: number };

export const EXIT_REASON_LABELS: Record<string, string> = {
  stop_loss: "Stop loss",
  out_of_range: "Keluar range",
  breakout: "Breakout",
  fee_decay: "Fee melemah",
  max_hold: "Batas waktu",
  delisted: "Pool tidak dipantau lagi",
};
