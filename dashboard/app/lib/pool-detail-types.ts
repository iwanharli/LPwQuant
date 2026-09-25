import type { PoolRow, Tier } from "./types";

export type Timeframe = "1m" | "5m" | "30m" | "1h" | "4h";

export type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

export type CandleResponse = { address: string; tf: Timeframe; hours: number; source: "db" | "meteora" | "onchain" | "onchain+geckoterminal" | "geckoterminal"; candles: Candle[] };

export type ProfileDecision = {
  key: string;
  label: string;
  enter: boolean;
  reason: string | null;
  size_usd?: number;
  stop_loss_pct?: number | null;
  min_hold_hours?: number | null;
  holding?: {
    id: number;
    entry_ts: number;
    capital_usd: number;
    pnl_pct: number;
    min_price: number;
    max_price: number;
    in_range: boolean;
  };
};

export type PoolDetail = { updated_at: number | null; pool: PoolRow; profiles: ProfileDecision[] };

export type PoolPaperPosition = {
  id: number;
  profile: string;
  status: "open" | "closed";
  tier: Tier;
  strategy: string;
  capital_usd: number;
  entry_price: number;
  exit_price: number | null;
  min_price: number;
  max_price: number;
  pnl_pct: number;
  exit_reason: string | null;
  entry_ts: number;
  exit_ts: number | null;
};
