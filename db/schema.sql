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
-- Drawdown pauses: entries stop for PAUSE_HOURS, then resume with the peak measured from resumed_at on.
create table if not exists paper_pauses (
  profile     text not null,
  paused_at   timestamptz not null,
  resume_at   timestamptz not null,
  equity_usd  double precision not null,
  peak_usd    double precision not null,
  primary key (profile, paused_at)
);

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

-- Wallet activity: every transaction of a watched wallet, from the app (claims, limit orders it sent) and from the
-- chain (ingestor/src/wallet-history.ts), so actions taken on Meteora or Jupiter directly show up too.
create table if not exists portfolio_activity (
  signature  text primary key,
  wallet     text not null,
  ts         timestamptz not null,
  kind       text not null,  -- claim | add_liquidity | remove_liquidity | limit_order_place | limit_order_cancel | swap | transfer | other
  source     text not null,  -- app | chain
  ok         boolean not null default true,
  pool       text,
  sol_delta  double precision,
  deltas     jsonb not null default '[]',  -- [{mint, symbol, amount}] for the wallet's own token accounts
  note       text
);
create index if not exists portfolio_activity_wallet_ts on portfolio_activity (wallet, ts desc);
-- Instruction names from the logs: lets the classification be redone without re-reading the chain.
alter table portfolio_activity add column if not exists instructions text[];

-- Per-position history (engine snapshot loop, every 15 min).
create table if not exists portfolio_position_snapshots (
  wallet              text not null,
  ts                  timestamptz not null,
  position            text not null,
  pool                text not null,
  name                text not null,
  value_usd           double precision not null,
  pnl_usd             double precision not null,
  unclaimed_fees_usd  double precision not null,
  in_range            boolean,
  primary key (wallet, ts, position)
);

-- Everything the wallet owns, in one number over time: coins in the wallet, LP positions, open limit orders.
create table if not exists portfolio_networth_snapshots (
  wallet      text not null,
  ts          timestamptz not null,
  wallet_usd  double precision not null,
  lp_usd      double precision not null,
  orders_usd  double precision not null,
  total_usd   double precision not null,
  primary key (wallet, ts)
);

-- What the chain needs to tell deposits, gacha refunds and plain transfers apart (wallet-history.ts).
alter table portfolio_activity add column if not exists programs text[];       -- programs invoked
alter table portfolio_activity add column if not exists signed boolean;        -- did the wallet sign it
alter table portfolio_activity add column if not exists counterparty text;     -- the other side of a transfer

-- Where each extra account (the wallet's token accounts) was last read up to: incoming USDC lands on the token
-- account, not the wallet address, so the wallet's own signature list never shows a top-up.
create table if not exists portfolio_sync_cursor (
  wallet     text not null,
  account    text not null,
  signature  text not null,
  primary key (wallet, account)
);

-- Capital put in or taken out, as the user remembers it (a QRIS top-up in rupiah) or as detected on chain.
create table if not exists portfolio_capital (
  id          bigserial primary key,
  wallet      text not null,
  ts          timestamptz not null,
  amount_idr  double precision,          -- what was paid, when entered by hand in rupiah
  amount_usd  double precision not null, -- deposit > 0, withdrawal < 0
  source      text not null,             -- manual | chain
  signature   text unique,               -- chain entries: the transaction
  note        text
);
create index if not exists portfolio_capital_wallet on portfolio_capital (wallet, ts);

-- Guard alerts already sent (one per wallet, day and threshold).
create table if not exists portfolio_guard_sent (
  wallet  text not null,
  day     date not null,
  key     text not null,
  primary key (wallet, day, key)
);

-- Paper limit orders (engine/app/paper_lo.py): the recommended buy-low / sell-high rule run on live prices, no
-- transactions. One row per order from placement to close.
create table if not exists paper_lo_orders (
  id           bigserial primary key,
  pool         text not null,
  name         text not null,
  quote        text not null,          -- SOL | USDC
  opened_at    timestamptz not null,
  status       text not null,          -- waiting | holding | closed | expired
  step_pct     double precision not null,
  buy_price    double precision not null,
  sell_price   double precision not null,
  stop_price   double precision not null,
  size_quote   double precision not null,  -- quote spent on the buy (0.5 SOL, or its USDC value)
  sol_usd      double precision,           -- SOL price at placement, for USDC orders' SOL figures
  filled_at    timestamptz,
  qty          double precision,           -- tokens bought
  closed_at    timestamptz,
  exit_price   double precision,
  exit_reason  text,                       -- target | stop | time | expired
  pnl_quote    double precision,
  pnl_sol      double precision,
  replay_pct   double precision            -- the 48h replay the pick was made on, to compare with what happened
);
create index if not exists paper_lo_status on paper_lo_orders (status);

-- Every LP position of a watched wallet and its events (Meteora /positions/{addr}/historical), cached: the events'
-- signatures tie each LP transaction to its position and pool, which a transaction's balance changes cannot.
create table if not exists portfolio_positions_index (
  position    text primary key,
  wallet      text not null,
  pool        text not null,
  mint_x      text,
  mint_y      text,
  symbol_x    text,
  symbol_y    text,
  opened_at   timestamptz,
  closed_at   timestamptz,
  status      text not null,              -- open | closed
  meteora_pnl_usd double precision,
  fees_usd    double precision,
  deposit_usd double precision,
  events_fetched_at timestamptz
);
create index if not exists portfolio_positions_index_wallet on portfolio_positions_index (wallet);
create table if not exists portfolio_position_events (
  signature   text not null,
  position    text not null,
  pool        text not null,
  event_type  text not null,              -- add | remove | claim_fee | ...
  ts          timestamptz not null,
  amount_x    double precision,
  amount_y    double precision,
  usd         double precision,
  primary key (signature, position, event_type)
);
create index if not exists portfolio_position_events_sig on portfolio_position_events (signature);

-- Costs of each transaction: network + priority fee, and the pool fee paid on Meteora DLMM swaps (from the program's
-- Swap events: amount in the input token). Swaps through other DEXes have no decodable fee and are counted as such.
alter table portfolio_activity add column if not exists network_fee_lamports bigint;
alter table portfolio_activity add column if not exists pool_fees jsonb;          -- [{mint, amount}] in display units
alter table portfolio_activity add column if not exists other_dex_swap boolean;   -- a swap hop outside Meteora

-- Paper test of being a pool creator: the engine joins brand-new high-fee DLMM pools as their first LP (as if it had
-- created them) and follows fees (its share of the pool's), the position's value and costs until an exit rule fires.
create table if not exists paper_pool_runs (
  id            bigserial primary key,
  pool          text not null,
  name          text not null,
  mint          text not null,
  quote         text not null,                -- SOL | USDC
  base_fee_pct  double precision not null,
  opened_at     timestamptz not null,
  pool_age_min  double precision,             -- pool's age when joined
  status        text not null,                -- open | closed
  size_usd      double precision not null,
  sol_usd       double precision not null,
  entry_price   double precision not null,
  range_low     double precision not null,    -- multiples of entry_price
  range_high    double precision not null,
  last_cum_fees double precision not null,    -- pool's lifetime fees at the last tick
  fees_usd      double precision not null default 0,
  in_range_ticks integer not null default 0,
  ticks         integer not null default 0,
  last_price    double precision,
  last_tvl      double precision,
  peak_fee_hour double precision not null default 0,
  checked_at    timestamptz,
  closed_at     timestamptz,
  exit_reason   text,                         -- stop | below_range | fees_dried | time | vanished
  lp_value_usd  double precision,             -- position without fees at exit
  costs_usd     double precision,
  create_cost_usd double precision,
  pnl_usd       double precision              -- lp value + fees - size - costs (incl. pool creation)
);
create index if not exists paper_pool_runs_status on paper_pool_runs (status);
-- Version 2 (2026-09-25): fee share against the larger TVL of each interval capped at 50%, one-minute ticks, and an
-- exit when the pool's liquidity is pulled. Version 1 runs stay for comparison.
alter table paper_pool_runs add column if not exists version integer not null default 1;
alter table paper_pool_runs add column if not exists peak_tvl double precision;

-- Auto close + sell per position, for the bot wallet only (BOT_WALLET_SECRET in .env). The ingestor watches armed
-- positions and, once the net result after the exit swap reaches target_pct, closes and sells without a prompt.
create table if not exists auto_close (
  position     text primary key,
  pool         text not null,
  owner        text not null,
  enabled      boolean not null default true,
  target_pct   double precision not null,
  status       text not null default 'armed',   -- armed | closing | done | failed
  basis_usd    double precision,                 -- deposits minus fees/withdrawals already taken out (Meteora)
  last_net_pct double precision,                 -- latest check, before the exit swap for the quick estimate
  last_checked_at timestamptz,
  close_sigs   text[],
  sell_sig     text,
  result_usd   double precision,                 -- net at the moment of closing, from the Jupiter quote
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Passkey login for the dashboard (WebAuthn): the credential's public key only, never a password or a private key.
create table if not exists auth_credentials (
  id            text primary key,          -- credential id, base64url
  label         text not null,             -- what the user called this device
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[],
  backed_up     boolean not null default false,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
-- Short-lived WebAuthn challenges, and the browser sessions a successful login creates.
create table if not exists auth_challenges (
  challenge  text primary key,
  kind       text not null,                -- register | login
  expires_at timestamptz not null
);
create table if not exists auth_sessions (
  token_hash text primary key,             -- sha256 of the cookie value; the cookie itself is never stored
  credential text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index if not exists auth_sessions_expires on auth_sessions (expires_at);

-- Paper test of the Panda Strat (see engine/app/panda.py): one-sided quote liquidity spread very wide below the
-- price, entered on a Supertrend break and exited on the strategy's own indicator confluence.
create table if not exists paper_panda_runs (
  id              bigserial primary key,
  pool            text not null,
  name            text not null,
  mint            text not null,
  quote           text not null,
  opened_at       timestamptz not null,
  status          text not null,               -- open | closed
  size_usd        double precision not null,
  sol_usd         double precision not null,
  entry_price     double precision not null,
  range_low_pct   double precision not null,
  bins            integer not null,
  last_cum_fees   double precision not null,
  fees_usd        double precision not null default 0,
  ticks           integer not null default 0,
  last_price      double precision,
  last_tvl        double precision,
  last_volume_24h double precision,
  min_ratio       double precision not null default 1,  -- deepest the price went, as a fraction of entry
  new_arrays      integer not null default 0,           -- bin arrays the range had to create (rent that never returns)
  checked_at      timestamptz,
  closed_at       timestamptz,
  exit_reason     text,                        -- rsi2_bb | rsi2_macd | flatline | time | vanished
  lp_value_usd    double precision,
  token_value_usd double precision,
  costs_usd       double precision,
  rent_usd        double precision,
  pnl_usd         double precision
);
create index if not exists paper_panda_runs_status on paper_panda_runs (status);
alter table paper_panda_runs add column if not exists new_arrays integer not null default 0;
-- Set once the range's bin arrays were checked on chain (2026-09-26); earlier runs had new_arrays left at 0.
alter table paper_panda_runs add column if not exists rent_checked boolean not null default false;
-- 2 = per-bin fee share (2026-09-26); 1 = the earlier value/(value+TVL), rescaled once by _fix_fees.
alter table paper_panda_runs add column if not exists fee_model integer not null default 1;
-- The price range each position served, so a flat "latest closed positions" list does not need one Meteora call
-- per pool to draw its range bar.
alter table portfolio_positions_index add column if not exists min_price double precision;
alter table portfolio_positions_index add column if not exists max_price double precision;
-- The cost accounting's result per position, stored so the history page reads it instead of waiting for a
-- recompute of every transaction (which takes ~45s cold).
alter table portfolio_positions_index add column if not exists cost_lp double precision;
alter table portfolio_positions_index add column if not exists cost_swaps double precision;
-- Shown in the cost breakdown only (already inside net_usd): bin-array rent the position opened, transfer tax paid.
alter table portfolio_positions_index add column if not exists cost_rent double precision;
alter table portfolio_positions_index add column if not exists cost_tax double precision;
alter table portfolio_positions_index add column if not exists net_usd double precision;
alter table portfolio_positions_index add column if not exists net_at timestamptz;

-- Paper grid of limit orders on SOL-USDC (engine/app/sol_grid.py), started 2026-09-26. One row per level.
create table if not exists paper_sol_grid (
  level       integer primary key,
  state       text not null,              -- buy (USDC waiting to buy) | sell (SOL waiting to sell)
  buy_price   double precision not null,
  sell_price  double precision not null,
  usd         double precision not null,  -- USDC held by the level while it waits to buy
  sol         double precision not null,  -- SOL held by the level while it waits to sell
  updated_at  timestamptz not null
);
create table if not exists paper_sol_grid_fills (
  id          bigserial primary key,
  ts          timestamptz not null,
  level       integer not null,
  side        text not null,              -- buy | sell | recenter
  price       double precision not null,
  sol         double precision not null,
  usd         double precision not null,
  profit_usd  double precision            -- on a sell: what the round trip made
);
create table if not exists paper_sol_grid_equity (
  ts          timestamptz primary key,
  price       double precision not null,
  equity_usd  double precision not null
);

-- LP leaderboard (engine/app/lp_leaders.py): one row per Meteora wallet, statistics as JSON, refreshed every 6h.
create table if not exists lp_leaders (
  wallet      text primary key,
  stats       jsonb not null,
  updated_at  timestamptz not null
);

-- Copy-trading paper test (engine/app/copy_paper.py): positions of followed LP wallets, copied at $100.
create table if not exists paper_copy_seen (
  position    text primary key,
  wallet      text not null,
  first_seen  timestamptz not null
);
create index if not exists paper_copy_seen_wallet on paper_copy_seen (wallet);
create table if not exists paper_copy_runs (
  id                bigserial primary key,
  wallet            text not null,
  position          text not null unique,
  pool              text not null,
  pair              text not null,
  their_created_at  timestamptz,
  opened_at         timestamptz not null,   -- when we saw it: the copy starts here
  status            text not null,          -- open | closed
  size_usd          double precision not null,
  entry_pnl_pct     double precision,       -- the wallet's PnL % when we saw it
  last_pnl_pct      double precision,
  exit_pnl_pct      double precision,
  result_pct        double precision,
  their_deposit_usd double precision,
  min_price         double precision,
  max_price         double precision,
  costs_usd         double precision,
  pnl_usd           double precision,
  checked_at        timestamptz,
  closed_at         timestamptz
);
create index if not exists paper_copy_runs_status on paper_copy_runs (status);

-- Paper test "Brontosaurus" (engine/app/brontosaurus.py): wide spot ranges on high-fee memecoin/SOL pools, ~12h holds.
create table if not exists paper_bronto_runs (
  id              bigserial primary key,
  pool            text not null,
  name            text not null,
  mint            text not null,
  opened_at       timestamptz not null,
  status          text not null,               -- open | closed
  size_usd        double precision not null,
  entry_price     double precision not null,
  bin_step        integer not null,
  base_fee_pct    double precision,
  last_cum_fees   double precision not null,
  fees_usd        double precision not null default 0,
  last_price      double precision,
  last_tvl        double precision,
  peak_tvl        double precision,
  new_arrays      integer not null default 0,
  entry_cost_usd  double precision,
  exit_cost_usd   double precision,
  lp_value_usd    double precision,
  pnl_usd         double precision,
  exit_reason     text,                        -- target | time | pulled | vanished
  checked_at      timestamptz,
  closed_at       timestamptz
);
create index if not exists paper_bronto_runs_status on paper_bronto_runs (status);

-- Web Push (engine/app/web_push.py): browser/phone subscriptions, and the pools already announced.
create table if not exists push_subscriptions (
  endpoint    text primary key,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create table if not exists push_sent (
  address     text primary key,
  sent_at     timestamptz not null
);

-- Dangerous pool creators (engine/app/danger_wallets.py): young pools watched with their on-chain creator, and the
-- events that list a creator (pool drained after launch, or a very suspicious pool).
create table if not exists danger_pool_watch (
  pool        text primary key,
  name        text not null,
  creator     text,
  peak_tvl    double precision not null default 0,
  last_tvl    double precision,
  first_seen  timestamptz not null
);
create table if not exists danger_events (
  pool        text not null,
  creator     text not null,
  kind        text not null,            -- drained | suspicious
  name        text not null,
  evidence    jsonb not null,
  seen_at     timestamptz not null,
  primary key (pool, kind)
);
create index if not exists danger_events_creator on danger_events (creator);

-- Danger-wallet network: each traced wallet's funders and SOL counterparties (ingestor /wallet-trace).
create table if not exists danger_traces (
  wallet      text primary key,
  role        text not null,            -- creator | funder | manual
  data        jsonb,
  error       text,
  traced_at   timestamptz not null
);
