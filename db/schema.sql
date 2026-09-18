-- Idempotent schema; applied on startup by both ingestor and engine.

create table if not exists pools (
  address          text primary key,
  name             text not null,
  mint_x           text not null,
  mint_y           text not null,
  symbol_x         text,
  symbol_y         text,
  decimals_x       integer not null,
  decimals_y       integer not null,
  bin_step         integer not null,
  base_fee_pct     double precision,
  pool_created_at  timestamptz,
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One row per pool per API poll.
create table if not exists pool_snapshots (
  ts               timestamptz not null,
  address          text not null,
  price            double precision,
  tvl              double precision,
  volume_1h        double precision,
  volume_24h       double precision,
  fees_1h          double precision,
  fees_24h         double precision,
  fee_tvl_pct_24h  double precision,
  dynamic_fee_pct  double precision,
  token_x          jsonb,
  token_y          jsonb
);
create index if not exists pool_snapshots_address_ts on pool_snapshots (address, ts desc);
create index if not exists pool_snapshots_ts_brin on pool_snapshots using brin (ts);

-- On-chain active-bin changes from the websocket watcher.
create table if not exists price_ticks (
  ts         timestamptz not null,
  address    text not null,
  slot       bigint not null,
  active_id  integer not null,
  price      double precision not null
);
create index if not exists price_ticks_address_ts on price_ticks (address, ts desc);
create index if not exists price_ticks_ts_brin on price_ticks using brin (ts);

-- RPC usage counters per hour, to estimate provider credit consumption.
create table if not exists rpc_usage (
  hour      timestamptz not null,
  provider  text not null,
  kind      text not null,  -- http | http_error | ws_subscribe | ws_message
  method    text not null,
  count     bigint not null default 0,
  primary key (hour, provider, kind, method)
);
-- When counting started for this bucket; lets projections use real coverage, not whole hours.
alter table rpc_usage add column if not exists first_at timestamptz not null default now();

-- Engine output, one row per pool per scoring pass.
create table if not exists pool_metrics (
  ts                   timestamptz not null,
  address              text not null,
  score                double precision not null,
  fee_tvl_pct_24h      double precision,
  fee_tvl_pct_1h_x24   double precision,
  volume_tvl_24h       double precision,
  change_pct_1h        double precision,
  realized_vol_pct_1h  double precision,
  flags                text[] not null default '{}'
);
create index if not exists pool_metrics_address_ts on pool_metrics (address, ts desc);
create index if not exists pool_metrics_ts_brin on pool_metrics using brin (ts);
alter table pool_metrics add column if not exists safety double precision;
alter table pool_metrics add column if not exists fee_for_position_pct_day double precision;
alter table pool_metrics add column if not exists recommendation jsonb;

alter table pool_metrics add column if not exists regime text;

-- OHLCV candles from the Meteora API (prices in quote token, volume in USD).
create table if not exists candles (
  address    text not null,
  timeframe  text not null,
  ts         timestamptz not null,  -- candle open time
  open       double precision not null,
  high       double precision not null,
  low        double precision not null,
  close      double precision not null,
  volume     double precision not null,
  primary key (address, timeframe, ts)
);

-- Buy/sell transaction counts per window from GeckoTerminal, oriented to our base token.
create table if not exists pool_flow (
  ts       timestamptz not null,
  address  text not null,
  data     jsonb not null
);
create index if not exists pool_flow_address_ts on pool_flow (address, ts desc);
create index if not exists pool_flow_ts_brin on pool_flow using brin (ts);

-- Normalized RugCheck report per token mint (refreshed by the ingestor).
create table if not exists token_security (
  mint        text primary key,
  fetched_at  timestamptz not null,
  data        jsonb not null
);

-- pump.fun data for tokens launched there (ingestor/src/pump.ts): graduation, all-time-high market cap, bans,
-- PumpSwap liquidity.
create table if not exists token_pump (
  mint        text primary key,
  fetched_at  timestamptz not null,
  data        jsonb not null
);

-- Jupiter organic score per token mint (ingestor/src/jupiter.ts): real-user vs bot/wash trading activity.
create table if not exists token_organic (
  mint        text primary key,
  fetched_at  timestamptz not null,
  data        jsonb not null
);

-- Paper trading: virtual LP positions opened from live plans (engine/app/paper.py). Values in token Y.
create table if not exists paper_positions (
  id                  bigserial primary key,
  status              text not null default 'open',  -- open | closed
  address             text not null,
  name                text not null,
  base_mint           text,
  quote_symbol        text,
  tier                text not null,
  strategy            text not null,
  regime              text,
  score               double precision,
  bin_step            integer not null,
  entry_ts            timestamptz not null,
  entry_price         double precision not null,
  range_low_pct       double precision not null,
  range_high_pct      double precision not null,
  min_price           double precision not null,
  max_price           double precision not null,
  capital_usd         double precision not null,
  capital_y           double precision not null,
  entry_fee_rate      double precision not null default 0,  -- pool fee/TVL per hour at entry
  exit_rules          jsonb not null,
  entry_snapshot      jsonb not null,  -- plan, flags, indicators, security, GMGN at entry
  value_y             double precision not null,
  fees_y              double precision not null default 0,
  last_price          double precision not null,
  last_update_ts      timestamptz not null,
  out_of_range_since  timestamptz,
  pnl_pct             double precision not null default 0,
  fee_pct             double precision not null default 0,
  il_pct              double precision not null default 0,
  exit_ts             timestamptz,
  exit_price          double precision,
  exit_reason         text
);
create index if not exists paper_positions_status_entry on paper_positions (status, entry_ts desc);
-- Execution costs (engine/app/paper.py CostModel). Values in token Y; cost_pct and gross_pnl_pct vs capital.
alter table paper_positions add column if not exists positions integer not null default 1;
alter table paper_positions add column if not exists cost_entry_y double precision not null default 0;
alter table paper_positions add column if not exists cost_exit_y double precision not null default 0;
alter table paper_positions add column if not exists rent_sol double precision not null default 0;
alter table paper_positions add column if not exists cost_pct double precision not null default 0;
alter table paper_positions add column if not exists gross_pnl_pct double precision;
-- Risk profile (engine/app/profiles.py); positions from before profiles existed belong to 'moderat'.
alter table paper_positions add column if not exists profile text not null default 'moderat';
create index if not exists paper_positions_profile_status on paper_positions (profile, status, entry_ts desc);

create table if not exists paper_equity (
  ts              timestamptz not null,
  equity_usd      double precision not null,
  realized_usd    double precision not null,
  unrealized_usd  double precision not null,
  open_count      integer not null
);
create index if not exists paper_equity_ts_brin on paper_equity using brin (ts);
alter table paper_equity add column if not exists profile text not null default 'moderat';
create index if not exists paper_equity_profile_ts on paper_equity (profile, ts);

-- GMGN insider/dev/smart-money data per token mint: latest value plus history for later backtests.
create table if not exists token_insights (
  mint        text primary key,
  fetched_at  timestamptz not null,
  data        jsonb not null
);
create table if not exists token_insight_snapshots (
  ts    timestamptz not null,
  mint  text not null,
  data  jsonb not null
);
create index if not exists token_insight_snapshots_mint_ts on token_insight_snapshots (mint, ts desc);
create index if not exists token_insight_snapshots_ts_brin on token_insight_snapshots using brin (ts);

-- Momentum swap-bot backtests (engine/app/momentum.py). One row per run; the dashboard shows the newest.
create table if not exists momentum_runs (
  ts       timestamptz not null,
  hours    double precision not null,
  results  jsonb not null
);
create index if not exists momentum_runs_ts on momentum_runs (ts desc);

-- Telegram alerts already delivered (engine/app/alerts.py). One row per pool per kind, so a pool fires once and
-- a restart does not replay it. The first cycle for a kind seeds this table without sending.
create table if not exists alerts_sent (
  kind     text not null,
  address  text not null,
  ts       timestamptz not null default now(),
  primary key (kind, address)
);
create index if not exists alerts_sent_ts on alerts_sent (ts desc);

-- TVL the stored fee rate was measured against (engine/app/paper.py Position.last_tvl), so a restart keeps
-- accruing instead of skipping a cycle to re-seed it.
alter table paper_positions add column if not exists last_tvl double precision;

-- The user's own LP portfolio (engine/app/portfolio.py): public wallet addresses only, read-only.
create table if not exists portfolio_wallets (
  address   text primary key,
  added_at  timestamptz not null default now()
);
create table if not exists portfolio_snapshots (
  wallet              text not null,
  ts                  timestamptz not null,
  value_usd           double precision not null,
  value_sol           double precision not null,
  deposit_usd         double precision not null,
  unclaimed_fees_usd  double precision not null,
  open_pnl_usd        double precision not null,
  open_pnl_sol        double precision not null,
  closed_pnl_usd      double precision not null,
  closed_pnl_sol      double precision not null,
  positions           integer not null,
  primary key (wallet, ts)
);
