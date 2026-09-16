"""Paper trading: virtual LP positions opened from the engine's live plans and managed with the same exit
rules as the backtest. Nothing is ever sent on-chain; there is no wallet.

Model (same approximations as app.backtest): uniform liquidity across bins; while in range the position
earns the pool's live 1h fee/TVL rate, diluted by its own size; values are in the pool's token Y (usually
SOL or USDC). USD PnL applies the token-Y return to the USD capital, so the quote token's own price moves
(e.g. SOL/USD) are excluded.

Execution costs (CostModel): Solana tx fees per position, swap fee + price impact to build the position
(the base-token share of the range) and to exit it (the base tokens held at exit), and optional
non-refundable bin-array rent. Position rent is refundable, so it is tracked but not deducted. Open
positions are marked net of the cost to exit them now. Rent/tx constants come from the DLMM SDK.
"""

import json
import logging
import math
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

import asyncpg

from .backtest import LpPosition, summarize
from .costs import BINS_PER_BIN_ARRAY, CostModel, entry_costs, exit_cost, resized_cost_pct, round_trip_cost_pct, swap_cost_fraction  # noqa: F401
from .depth import realization_factor
from .scoring import effective_tvl
from .recommend import DEFAULT_MIN_HOLD_HOURS, FEE_RATE_AVG_HOURS, MIN_BREAKOUT_DISTANCE_PCT, cost_gate_ok
from .validation import bootstrap_mean_ci

log = logging.getLogger("paper")

HOUR_MS = 3_600_000
TIER_ORDER = ("low", "medium", "high")
MAX_EQUITY_POINTS = 600
SOL_MINT = "So11111111111111111111111111111111111111112"


def _dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def _ms(value: datetime | None) -> int | None:
    return int(value.timestamp() * 1000) if value else None


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _clean(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


@dataclass(frozen=True)
class PaperConfig:
    enabled: bool
    start_equity_usd: float
    max_open_per_tier: int
    tiers: tuple[str, ...]
    cooldown_hours: float
    costs: CostModel = CostModel()
    # Below this, fixed tx costs dominate: a $10 position paid ~4% in costs on entry.
    min_position_usd: float = 25.0
    # Stop opening positions once equity falls this far below its peak (None = never pause).
    max_drawdown_pct: float | None = 10.0
    # Risk profile (app.profiles). Positions and equity are stored per profile; several traders run side by side
    # on the same live plans. A profile re-gates the engine's un-gated plan with its own cost rule when
    # min_fee_cost_ratio is set; None follows the live plan as gated by the engine.
    profile: str = "moderat"
    label: str = "Moderat"
    description: str = ""
    size_mult: float = 1.0
    min_fee_cost_ratio: float | None = None
    fee_gate_hours: float | None = None
    min_hold_hours: float | None = None
    stop_loss_mult: float = 1.0
    max_tvl_share: float = 0.02
    # Minimum position size in USD (0 = off), still capped by max_tvl_share. Open positions never commit more capital
    # than the profile's equity.
    position_floor_usd: float = 0.0
    # Reject entries whose round trip costs more than this share of the position (None = no cap).
    max_round_trip_cost_pct: float | None = None
    # Upper bound on the stop-loss after stop_loss_mult.
    max_stop_loss_pct: float = 10.0
    # Only enter pools whose 30m ATR is at or below this (None = any volatility).
    max_atr_pct: float | None = None
    # Which plan the profile trades: "base" (two-sided, as the engine recommends) or "single" (quote only).
    plan_variant: str = "base"


def entries_paused(equity_usd: float, peak_equity_usd: float, max_drawdown_pct: float | None) -> bool:
    if max_drawdown_pct is None or peak_equity_usd <= 0:
        return False
    return equity_usd <= peak_equity_usd * (1 - max_drawdown_pct / 100)


@dataclass
class Position:
    id: int
    address: str
    name: str
    base_mint: str | None
    tier: str
    strategy: str
    bin_step: int
    entry_ts: int
    entry_price: float
    range_low_pct: float
    range_high_pct: float
    capital_usd: float
    capital_y: float
    entry_fee_rate: float
    exit_rules: dict[str, Any]
    value_y: float
    fees_y: float
    last_ts: int
    last_price: float
    last_rate: float
    out_of_range_since: int | None = None
    positions: int = 1
    cost_entry_y: float = 0.0
    cost_exit_y: float = 0.0  # estimated cost to exit at the last price
    rent_sol: float = 0.0
    # Fee rate (fraction of TVL per hour) smoothed over ~FEE_RATE_AVG_HOURS, so one quiet snapshot does not
    # trigger fee_decay. Not persisted: starts from the last rate after a restart.
    rate_avg: float | None = None
    # TVL that produced `last_rate`. Fees are rate x TVL share, and the two must come from the same snapshot:
    # reading the rate when TVL had collapsed and the share when it was back cost a $100 position $3.4M of
    # phantom fees in one cycle (CHIP-USDC, 2026-09-16 19:01 UTC).
    last_tvl: float = 0.0
    lp: LpPosition = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.lp = LpPosition.build(
            self.entry_price, self.bin_step, self.range_low_pct, self.range_high_pct, self.capital_y
        )

    @property
    def min_price(self) -> float:
        return self.entry_price * self.lp.r ** -self.lp.a

    @property
    def max_price(self) -> float:
        return self.entry_price * self.lp.r ** self.lp.b

    def gross_pnl_pct(self) -> float:
        return (self.value_y + self.fees_y - self.capital_y) / self.capital_y * 100

    def cost_pct(self) -> float:
        return (self.cost_entry_y + self.cost_exit_y) / self.capital_y * 100

    def pnl_pct(self) -> float:
        """Net of entry costs and the cost to exit at the last price."""
        return self.gross_pnl_pct() - self.cost_pct()

    def fee_pct(self) -> float:
        return self.fees_y / self.capital_y * 100

    def il_pct(self) -> float:
        return (self.value_y - self.lp.hodl_value(self.last_price)) / self.capital_y * 100

    def hold_hours(self, now_ms: int) -> float:
        return (now_ms - self.entry_ts) / HOUR_MS


def sanitize_exit_rules(
    rules: dict[str, Any], atr_pct: float | None, max_stop_loss_pct: float | None = None
) -> dict[str, Any]:
    """Bring rules stored by an older engine version up to the current ones: drop breakout levels that are now
    too tight, add the minimum hold, and cap the stop-loss. Positions opened before a rule change otherwise keep
    stops as wide as 30%."""
    min_distance = max(MIN_BREAKOUT_DISTANCE_PCT, atr_pct or 0.0)
    out = dict(rules)
    out.setdefault("min_hold_hours", DEFAULT_MIN_HOLD_HOURS)
    if max_stop_loss_pct is not None and out.get("stop_loss_pct") is not None:
        out["stop_loss_pct"] = min(out["stop_loss_pct"], max_stop_loss_pct)
    below, above = out.get("breakout_below_pct"), out.get("breakout_above_pct")
    if below is not None and below > -min_distance:
        out["breakout_below_pct"] = None
    if above is not None and above < min_distance:
        out["breakout_above_pct"] = None
    return out


def sol_usd_from_pools(pools: Iterable[dict[str, Any]]) -> float | None:
    for pool in pools:
        for side in ("token_x", "token_y"):
            token = pool.get(side) or {}
            if token.get("mint") == SOL_MINT and (token.get("price_usd") or 0) > 0:
                return token["price_usd"]
    return None


def pool_fee_rate(pool: dict[str, Any]) -> float:
    """Pool fees over the last hour as a fraction of TVL, per hour, against the floored TVL (app.scoring)."""
    tvl = effective_tvl(pool)
    return (pool.get("fees", {}).get("1h") or 0.0) / tvl if tvl > 0 else 0.0


def accrue(
    pos: Position,
    pool: dict[str, Any],
    now_ms: int,
    model: CostModel | None = None,
    sol_usd: float | None = None,
) -> None:
    """Advance a position to `now_ms`: fees earned since the last update (at the previous price and fee rate, like
    the backtest), then revalue at the current price and re-estimate the exit cost.

    Fees: the pool's fee rate times the position's TVL share, scaled by the realization factor for its range width
    (app.depth, calibrated on real LP positions)."""
    tvl = effective_tvl(pool)
    y_usd = (pool.get("token_y") or {}).get("price_usd") or 0.0
    dt_h = max(0.0, (now_ms - pos.last_ts) / HOUR_MS)
    share_tvl = pos.last_tvl  # the TVL `last_rate` was measured against, never the current one
    if share_tvl <= 0:
        # Restored from the database, where last_tvl is not stored. Seeding it from the current snapshot and
        # skipping this one cycle costs a minute of fees; pairing the stored rate with today's TVL would not.
        pos.last_tvl = tvl
    if dt_h > 0 and pos.last_rate > 0 and share_tvl > 0 and pos.lp.in_range(pos.last_price):
        realization = realization_factor(pos.lp.a + pos.lp.b + 1)
        pos.fees_y += pos.value_y * pos.last_rate * dt_h * share_tvl / (share_tvl + pos.capital_usd) * realization
    price = pool["price"]
    pos.value_y = pos.lp.value(price)
    pos.out_of_range_since = None if pos.lp.in_range(price) else (pos.out_of_range_since or now_ms)
    rate = pool_fee_rate(pool)
    if pos.rate_avg is None:
        pos.rate_avg = pos.last_rate
    alpha = 1 - math.exp(-dt_h / FEE_RATE_AVG_HOURS) if dt_h > 0 else 0.0
    pos.rate_avg += alpha * (rate - pos.rate_avg)
    pos.last_ts, pos.last_price, pos.last_rate, pos.last_tvl = now_ms, price, rate, tvl
    if model is not None and y_usd > 0 and sol_usd:
        pos.cost_exit_y = exit_cost(pos.lp, price, pos.positions, pool, y_usd, sol_usd / y_usd, model)


def exit_reason(pos: Position, now_ms: int) -> str | None:
    """Same exit rules, in the same order, as app.backtest.simulate."""
    rules = pos.exit_rules
    held = pos.hold_hours(now_ms)
    if pos.pnl_pct() <= -rules["stop_loss_pct"]:
        return "stop_loss"
    if pos.out_of_range_since is not None and (now_ms - pos.out_of_range_since) / 60_000 >= rules["out_of_range_minutes"]:
        return "out_of_range"
    # Before the minimum hold only the protective exits above apply: fees need time to pay back entry costs.
    if held < (rules.get("min_hold_hours") or 0.0):
        return None
    below, above = rules.get("breakout_below_pct"), rules.get("breakout_above_pct")
    if below is not None and pos.last_price < pos.entry_price * (1 + below / 100):
        return "breakout"
    if above is not None and pos.last_price > pos.entry_price * (1 + above / 100):
        return "breakout"
    rate = pos.rate_avg if pos.rate_avg is not None else pos.last_rate
    if held >= 1 and pos.entry_fee_rate > 0 and rate < pos.entry_fee_rate * rules["fee_decay_ratio"]:
        return "fee_decay"
    if held >= rules["max_hold_hours"]:
        return "max_hold"
    return None


def profile_plan(
    row: dict[str, Any], cfg: PaperConfig, equity_usd: float | None = None
) -> dict[str, Any] | None:
    """The row's entry plan as this profile would trade it, or None when the profile skips it: tier not allowed,
    or fees over the profile's gate window below its multiple of the round-trip cost.

    Size is the plan's size_pct of the profile's current equity (the plan itself is sized on PORTFOLIO_USD), times
    the profile's size multiplier, capped by TVL share. The cost gate re-prices the round trip at that size: fixed
    costs (transactions, bin array rent) weigh more on small positions."""
    if cfg.plan_variant == "single":
        plan = row.get("plan_single")
        if plan is None:
            return None
        use_base = cfg.min_fee_cost_ratio is not None
    else:
        base = row.get("plan_base")
        use_base = cfg.min_fee_cost_ratio is not None and base is not None
        plan = base if use_base else (row.get("plan") or {})
    if plan.get("action") != "enter" or plan.get("tier") not in cfg.tiers:
        return None
    if cfg.max_atr_pct is not None:
        atr = (row.get("market") or {}).get("atr_pct")
        if atr is None or atr > cfg.max_atr_pct:
            return None
    base_size = plan.get("size_usd") or 0.0
    size = equity_usd * plan["size_pct"] / 100 if equity_usd and equity_usd > 0 and plan.get("size_pct") else base_size
    size *= cfg.size_mult
    size = max(size, cfg.position_floor_usd)
    tvl = row.get("tvl") or 0.0
    if tvl > 0:
        size = min(size, tvl * cfg.max_tvl_share)
    extra: dict[str, Any] = {}
    if use_base:
        cost = plan.get("round_trip_cost_pct")
        # The single-sided plan carries its own fee estimate (different range width).
        fee_day = plan.get("fee_for_position_pct_day") or row.get("fee_for_position_pct_day")
        if cost is not None and fee_day is not None:
            cost = resized_cost_pct(cost, plan.get("fixed_cost_usd") or 0.0, base_size, size)
            if cfg.max_round_trip_cost_pct is not None and cost > cfg.max_round_trip_cost_pct:
                return None
            hours = cfg.fee_gate_hours if cfg.fee_gate_hours is not None else 1.0
            if not cost_gate_ok(cost, fee_day, hours, cfg.min_fee_cost_ratio):
                return None
            extra["round_trip_cost_pct"] = round(cost, 3)
    rules = dict(plan.get("exit") or {})
    if rules.get("stop_loss_pct") is not None:
        scaled = rules["stop_loss_pct"] * cfg.stop_loss_mult
        rules["stop_loss_pct"] = round(min(max(2.0, scaled), cfg.max_stop_loss_pct), 1)
    if cfg.min_hold_hours is not None:
        rules["min_hold_hours"] = cfg.min_hold_hours
        rules["max_hold_hours"] = max(rules.get("max_hold_hours") or 0.0, cfg.min_hold_hours)
    return dict(plan, size_usd=round(size, 2), exit=rules, profile=cfg.profile, **extra)


def pick_entries(
    rows: Iterable[dict[str, Any]],
    open_positions: Iterable[Position],
    last_closed: dict[str, int],
    cfg: PaperConfig,
    now_ms: int,
    last_closed_mints: dict[str, int] | None = None,
    equity_usd: float | None = None,
    sol_usd: float | None = None,
) -> list[dict[str, Any]]:
    """Highest-score pools with an entry plan, capped per tier, one position per pool and per token,
    skipping pools and tokens closed within the cooldown (a token trades in several pools)."""
    closed_mints = last_closed_mints or {}
    open_list = list(open_positions)
    per_tier = Counter(p.tier for p in open_list)
    addresses = {p.address for p in open_list}
    mints = {p.base_mint for p in open_list if p.base_mint}
    cooldown_ms = cfg.cooldown_hours * HOUR_MS
    # Capital not yet committed to open positions; None when sizing does not follow equity.
    # Position rent is refunded on close but must be held in SOL meanwhile, so it is not available for new entries.
    rent_usd = sum(p.rent_sol for p in open_list) * (sol_usd or 0.0)
    available = equity_usd - sum(p.capital_usd for p in open_list) - rent_usd if equity_usd else None
    picked = []
    for row in sorted(rows, key=lambda r: r.get("score") or 0.0, reverse=True):
        plan = profile_plan(row, cfg, equity_usd)
        if plan is None:
            continue
        tier = plan["tier"]
        if per_tier[tier] >= cfg.max_open_per_tier:
            continue
        if row["address"] in addresses or (row.get("base_mint") and row["base_mint"] in mints):
            continue
        closed_at = max(last_closed.get(row["address"], -1), closed_mints.get(row.get("base_mint") or "", -1))
        if closed_at >= 0 and now_ms - closed_at < cooldown_ms:
            continue
        if (plan.get("size_usd") or 0) < max(1.0, cfg.min_position_usd) or not row.get("price"):
            continue
        if available is not None:
            if plan["size_usd"] > available:
                continue
            available -= plan["size_usd"]
        picked.append(dict(row, plan=plan))
        per_tier[tier] += 1
        addresses.add(row["address"])
        if row.get("base_mint"):
            mints.add(row["base_mint"])
    return picked


# Decision rule fixed on 2026-09-16, before looking at results: a profile needs this many closed positions before
# its outcome counts, then it is "profitable" only if the 95% CI of the mean net return per trade is above zero,
# "losing" if the whole CI is below zero, otherwise "inconclusive" (keep collecting or change the rules).
MIN_TRADES_FOR_VERDICT = 50


def verdict(stats: dict[str, Any], min_trades: int = MIN_TRADES_FOR_VERDICT) -> dict[str, Any]:
    trades = int(stats.get("trades") or 0)
    if trades < min_trades:
        return {"status": "collecting", "trades": trades, "trades_needed": min_trades - trades}
    low, high = stats.get("ci_low"), stats.get("ci_high")
    if low is not None and low > 0:
        status = "profitable"
    elif high is not None and high < 0:
        status = "losing"
    else:
        status = "inconclusive"
    return {"status": status, "trades": trades, "trades_needed": 0}


def _trade_stats(trades: list[dict[str, Any]]) -> dict[str, Any]:
    stats = summarize(trades)
    ci = bootstrap_mean_ci(trades) if trades else {"low": None, "high": None}
    stats["ci_low"], stats["ci_high"] = ci["low"], ci["high"]
    if trades:
        stats["mean_cost_pct"] = sum(t["cost_pct"] for t in trades) / len(trades)
        stats["mean_gross_return_pct"] = sum(t["gross_return_pct"] for t in trades) / len(trades)
    return stats


class PaperTrader:
    def __init__(self, db: asyncpg.Pool, cfg: PaperConfig) -> None:
        self.db = db
        self.cfg = cfg
        self.open: dict[int, Position] = {}
        self.last_closed: dict[str, int] = {}
        self.last_closed_mints: dict[str, int] = {}
        self.sol_usd: float | None = None
        self.peak_equity_usd = cfg.start_equity_usd
        self.entries_paused = False
        self.realized_usd = 0.0
        self.started_at: int | None = None

    async def load(self) -> None:
        async with self.db.acquire() as conn:
            stale: list[tuple[int, str]] = []
            for r in await conn.fetch("select * from paper_positions where status = 'open' and profile = $1", self.cfg.profile):
                snapshot = _json(r["entry_snapshot"]) or {}
                rules = sanitize_exit_rules(
                    _json(r["exit_rules"]), (snapshot.get("market") or {}).get("atr_pct"), self.cfg.max_stop_loss_pct
                )
                pos = Position(
                    id=r["id"], address=r["address"], name=r["name"], base_mint=r["base_mint"], tier=r["tier"],
                    strategy=r["strategy"], bin_step=r["bin_step"], entry_ts=_ms(r["entry_ts"]),
                    entry_price=r["entry_price"], range_low_pct=r["range_low_pct"],
                    range_high_pct=r["range_high_pct"], capital_usd=r["capital_usd"], capital_y=r["capital_y"],
                    entry_fee_rate=r["entry_fee_rate"], exit_rules=rules, value_y=r["value_y"],
                    fees_y=r["fees_y"], last_ts=_ms(r["last_update_ts"]), last_price=r["last_price"],
                    last_rate=r["entry_fee_rate"], out_of_range_since=_ms(r["out_of_range_since"]),
                    positions=r["positions"], cost_entry_y=r["cost_entry_y"], cost_exit_y=r["cost_exit_y"],
                    rent_sol=r["rent_sol"],
                )
                self.open[pos.id] = pos
                if rules != _json(r["exit_rules"]):
                    stale.append((pos.id, json.dumps(_clean(rules))))
            closed = await conn.fetch(
                "select address, max(exit_ts) as last_exit from paper_positions where status = 'closed' and profile = $1 "
                "group by address",
                self.cfg.profile,
            )
            if stale:
                # Rules tightened since these positions were opened (see sanitize_exit_rules): store what we apply.
                await conn.executemany("update paper_positions set exit_rules = $2::jsonb where id = $1", stale)
                log.info("paper[%s]: updated exit rules on %d open positions", self.cfg.profile, len(stale))
            self.last_closed = {r["address"]: _ms(r["last_exit"]) for r in closed}
            closed_mints = await conn.fetch(
                """select base_mint, max(exit_ts) as last_exit from paper_positions
                   where status = 'closed' and profile = $1 and base_mint is not null group by base_mint""",
                self.cfg.profile,
            )
            self.last_closed_mints = {r["base_mint"]: _ms(r["last_exit"]) for r in closed_mints}
            self.realized_usd = float(await conn.fetchval(
                "select coalesce(sum(capital_usd * pnl_pct / 100), 0) from paper_positions where status = 'closed' and profile = $1",
                self.cfg.profile,
            ))
            self.started_at = _ms(await conn.fetchval("select min(entry_ts) from paper_positions where profile = $1", self.cfg.profile))
            self.peak_equity_usd = max(
                self.cfg.start_equity_usd,
                float(await conn.fetchval(
                    "select coalesce(max(equity_usd), 0) from paper_equity where profile = $1", self.cfg.profile
                )),
            )
        log.info("paper[%s]: %d open positions, realized %.2f USD", self.cfg.profile, len(self.open), self.realized_usd)

    async def on_refresh(self, pools: dict[str, dict[str, Any]], rows: dict[str, dict[str, Any]], now_ms: int) -> None:
        if not self.cfg.enabled:
            return
        self.sol_usd = sol_usd_from_pools(pools.values()) or self.sol_usd
        for pos in list(self.open.values()):
            pool = pools.get(pos.address)
            row = rows.get(pos.address) or {}
            if pool is None or not pool.get("price"):
                await self._close(pos, "delisted", now_ms)
                continue
            accrue(pos, self._pool_ctx(pool, row), now_ms, self.cfg.costs, self.sol_usd)
            reason = exit_reason(pos, now_ms)
            if reason:
                await self._close(pos, reason, now_ms)
        await self._save_open(now_ms)
        equity = self.equity_usd()
        self.peak_equity_usd = max(self.peak_equity_usd, equity)
        paused = entries_paused(equity, self.peak_equity_usd, self.cfg.max_drawdown_pct)
        if paused and not self.entries_paused:
            log.warning("paper[%s]: equity %.2f is %.1f%%+ below peak %.2f, pausing new entries",
                        self.cfg.profile, equity, self.cfg.max_drawdown_pct, self.peak_equity_usd)
        self.entries_paused = paused
        if not paused:
            for row in pick_entries(
                rows.values(), self.open.values(), self.last_closed, self.cfg, now_ms, self.last_closed_mints,
                equity_usd=equity, sol_usd=self.sol_usd,
            ):
                await self._open(row, pools[row["address"]], now_ms)
        await self._record_equity(now_ms)

    async def reset(self) -> int:
        """Delete this profile's positions and equity history and start again from start_equity_usd."""
        async with self.db.acquire() as conn, conn.transaction():
            deleted = await conn.fetchval(
                "with d as (delete from paper_positions where profile = $1 returning 1) select count(*) from d",
                self.cfg.profile,
            )
            await conn.execute("delete from paper_equity where profile = $1", self.cfg.profile)
        self.open.clear()
        self.last_closed.clear()
        self.last_closed_mints.clear()
        self.realized_usd = 0.0
        self.peak_equity_usd = self.cfg.start_equity_usd
        self.entries_paused = False
        self.started_at = None
        log.warning("paper[%s]: reset, %d positions deleted, equity back to %.2f", self.cfg.profile, deleted,
                    self.cfg.start_equity_usd)
        return int(deleted)

    @staticmethod
    def _pool_ctx(pool: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
        """Pool snapshot plus the on-chain bin depth, so swap costs use bin depth instead of TVL."""
        per_bin = (row.get("depth") or {}).get("per_bin_usd")
        return dict(pool, depth_per_bin_usd=per_bin) if per_bin else pool

    def open_addresses(self) -> list[str]:
        return sorted({p.address for p in self.open.values()})

    async def _open(self, row: dict[str, Any], pool: dict[str, Any], now_ms: int) -> None:
        plan = row["plan"]
        y_usd = (pool.get("token_y") or {}).get("price_usd") or 0.0
        if y_usd <= 0 or (self.cfg.costs.enabled and not self.sol_usd):
            return
        price = row["price"]
        capital_usd = plan["size_usd"]
        rate = pool_fee_rate(pool)
        pos = Position(
            id=0, address=row["address"], name=row["name"], base_mint=row.get("base_mint"), tier=plan["tier"],
            strategy=plan["strategy"], bin_step=row["bin_step"], entry_ts=now_ms, entry_price=price,
            range_low_pct=plan["range_low_pct"], range_high_pct=plan["range_high_pct"], capital_usd=capital_usd,
            capital_y=capital_usd / y_usd, entry_fee_rate=rate, exit_rules=plan["exit"],
            value_y=capital_usd / y_usd, fees_y=0.0, last_ts=now_ms, last_price=price, last_rate=rate,
            last_tvl=effective_tvl(pool),
            positions=int(plan.get("positions") or 1),
        )
        pool = self._pool_ctx(pool, row)
        sol_to_y = (self.sol_usd or 0.0) / y_usd
        pos.cost_entry_y, pos.rent_sol = entry_costs(
            pos.lp, pos.positions, pool, y_usd, sol_to_y, self.cfg.costs, plan.get("new_bin_arrays")
        )
        pos.cost_exit_y = exit_cost(pos.lp, price, pos.positions, pool, y_usd, sol_to_y, self.cfg.costs)
        snapshot = {k: row.get(k) for k in ("score", "safety", "flags", "regime", "market", "insights", "security",
                                             "fee_for_position_pct_day", "tvl", "volume_24h")}
        snapshot["plan"] = plan
        pos.id = await self.db.fetchval(
            """
            insert into paper_positions (address, name, base_mint, quote_symbol, tier, strategy, regime, score, bin_step,
                entry_ts, entry_price, range_low_pct, range_high_pct, min_price, max_price, capital_usd, capital_y,
                entry_fee_rate, exit_rules, entry_snapshot, value_y, fees_y, last_price, last_update_ts,
                positions, cost_entry_y, cost_exit_y, rent_sol, cost_pct, pnl_pct, gross_pnl_pct, profile)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                    $19::jsonb, $20::jsonb, $21, 0, $22, $10, $23, $24, $25, $26, $27, $28, 0, $29)
            returning id
            """,
            pos.address, pos.name, pos.base_mint, row["name"].split("-")[-1], pos.tier, pos.strategy,
            plan.get("regime"), row.get("score"), pos.bin_step, _dt(now_ms), price, pos.range_low_pct,
            pos.range_high_pct, pos.min_price, pos.max_price, capital_usd, pos.capital_y, rate,
            json.dumps(_clean(plan["exit"])), json.dumps(_clean(snapshot)), pos.value_y, price,
            pos.positions, pos.cost_entry_y, pos.cost_exit_y, pos.rent_sol, pos.cost_pct(), pos.pnl_pct(),
            self.cfg.profile,
        )
        self.open[pos.id] = pos
        self.started_at = self.started_at or now_ms
        log.info(
            "paper[%s] open #%d %s tier=%s %s %.2f USD, cost %.2f%%", self.cfg.profile, pos.id, pos.name, pos.tier,
            pos.strategy,
            capital_usd, pos.cost_pct(),
        )

    async def _save_open(self, now_ms: int) -> None:
        if not self.open:
            return
        await self.db.executemany(
            """
            update paper_positions set value_y = $2, fees_y = $3, last_price = $4, last_update_ts = $5,
                out_of_range_since = $6, pnl_pct = $7, fee_pct = $8, il_pct = $9, cost_exit_y = $10,
                cost_pct = $11, gross_pnl_pct = $12
            where id = $1
            """,
            [
                (p.id, p.value_y, p.fees_y, p.last_price, _dt(now_ms),
                 _dt(p.out_of_range_since) if p.out_of_range_since else None, p.pnl_pct(), p.fee_pct(), p.il_pct(),
                 p.cost_exit_y, p.cost_pct(), p.gross_pnl_pct())
                for p in self.open.values()
            ],
        )

    async def _close(self, pos: Position, reason: str, now_ms: int) -> None:
        pnl = pos.pnl_pct()
        await self.db.execute(
            """
            update paper_positions set status = 'closed', value_y = $2, fees_y = $3, last_price = $4,
                last_update_ts = $5, pnl_pct = $6, fee_pct = $7, il_pct = $8, exit_ts = $5, exit_price = $4,
                exit_reason = $9, cost_exit_y = $10, cost_pct = $11, gross_pnl_pct = $12
            where id = $1
            """,
            pos.id, pos.value_y, pos.fees_y, pos.last_price, _dt(now_ms), pnl, pos.fee_pct(), pos.il_pct(), reason,
            pos.cost_exit_y, pos.cost_pct(), pos.gross_pnl_pct(),
        )
        self.realized_usd += pos.capital_usd * pnl / 100
        self.last_closed[pos.address] = now_ms
        if pos.base_mint:
            self.last_closed_mints[pos.base_mint] = now_ms
        del self.open[pos.id]
        log.info("paper[%s] close #%d %s %s %+.2f%%", self.cfg.profile, pos.id, pos.name, reason, pnl)

    def equity_usd(self) -> float:
        return self.cfg.start_equity_usd + self.realized_usd + self._unrealized_usd()

    def _unrealized_usd(self) -> float:
        return sum(p.capital_usd * p.pnl_pct() / 100 for p in self.open.values())

    async def _record_equity(self, now_ms: int) -> None:
        unrealized = self._unrealized_usd()
        await self.db.execute(
            """insert into paper_equity (ts, equity_usd, realized_usd, unrealized_usd, open_count, profile)
               values ($1, $2, $3, $4, $5, $6)""",
            _dt(now_ms), self.cfg.start_equity_usd + self.realized_usd + unrealized, self.realized_usd, unrealized,
            len(self.open), self.cfg.profile,
        )

    # read API

    def profile_info(self) -> dict[str, Any]:
        c = self.cfg
        return {
            "key": c.profile,
            "label": c.label,
            "description": c.description,
            "settings": {
                "tiers": list(c.tiers),
                "max_open_per_tier": c.max_open_per_tier,
                "size_mult": c.size_mult,
                "min_fee_cost_ratio": c.min_fee_cost_ratio,
                "fee_gate_hours": c.fee_gate_hours,
                "min_hold_hours": c.min_hold_hours,
                "stop_loss_mult": c.stop_loss_mult,
                "max_drawdown_pct": c.max_drawdown_pct,
                "position_floor_usd": c.position_floor_usd,
                "max_atr_pct": c.max_atr_pct,
                "plan_variant": c.plan_variant,
            },
        }

    async def compare_summary(self) -> dict[str, Any]:
        """Headline numbers for comparing profiles, including the worst peak-to-trough drawdown so far."""
        s = await self.summary()
        max_dd = await self.db.fetchval(
            """select coalesce(max((peak - equity_usd) / nullif(peak, 0) * 100), 0) from (
                   select equity_usd, max(equity_usd) over (order by ts) as peak
                   from paper_equity where profile = $1) t""",
            self.cfg.profile,
        )
        return _clean({
            **self.profile_info(),
            "start_equity_usd": s["start_equity_usd"],
            "equity_usd": s["equity_usd"],
            "realized_usd": s["realized_usd"],
            "unrealized_usd": s["unrealized_usd"],
            "open_count": s["open_count"],
            "closed_count": s["closed_count"],
            "costs_usd": s["costs"]["closed_cost_usd"] + s["costs"]["open_cost_usd"],
            "max_drawdown_pct": float(max_dd or 0.0),
            "entries_paused": s["risk"]["entries_paused"],
            "started_at": s["started_at"],
            "overall": s["overall"],
            "verdict": verdict(s["overall"]),
        })

    async def summary(self) -> dict[str, Any]:
        rows = await self.db.fetch(
            """select tier, strategy, exit_reason, pnl_pct, fee_pct, il_pct, cost_pct,
                      coalesce(gross_pnl_pct, pnl_pct) as gross_pnl_pct, capital_usd, entry_ts, exit_ts
               from paper_positions where status = 'closed' and profile = $1""",
            self.cfg.profile,
        )
        trades = [
            {
                "tier": r["tier"], "strategy": r["strategy"], "exit_reason": r["exit_reason"],
                "return_pct": r["pnl_pct"], "fee_pct": r["fee_pct"], "il_vs_hodl_pct": r["il_pct"],
                "cost_pct": r["cost_pct"], "gross_return_pct": r["gross_pnl_pct"],
                "cost_usd": r["capital_usd"] * r["cost_pct"] / 100,
                "hold_hours": (r["exit_ts"] - r["entry_ts"]).total_seconds() / 3600, "entry_ts": _ms(r["entry_ts"]),
            }
            for r in rows
        ]
        unrealized = self._unrealized_usd()
        costs = self.cfg.costs
        return _clean({
            "enabled": self.cfg.enabled,
            "profile": self.profile_info(),
            "config": {
                "max_open_per_tier": self.cfg.max_open_per_tier,
                "tiers": list(self.cfg.tiers),
                "cooldown_hours": self.cfg.cooldown_hours,
            },
            "risk": {
                "min_position_usd": self.cfg.min_position_usd,
                "max_drawdown_pct": self.cfg.max_drawdown_pct,
                "peak_equity_usd": self.peak_equity_usd,
                "drawdown_pct": (1 - (self.cfg.start_equity_usd + self.realized_usd + unrealized)
                                 / self.peak_equity_usd) * 100 if self.peak_equity_usd > 0 else 0.0,
                "entries_paused": self.entries_paused,
            },
            "costs": {
                "enabled": costs.enabled,
                "tx_cost_sol": costs.tx_cost_sol,
                "txs_per_position": costs.txs_open_per_position + costs.txs_close_per_position,
                "position_rent_sol": costs.position_rent_sol,
                "new_bin_array_share": costs.new_bin_array_share,
                "impact_multiplier": costs.impact_multiplier,
                "closed_cost_usd": sum(t["cost_usd"] for t in trades),
                "open_cost_usd": sum(p.capital_usd * p.cost_pct() / 100 for p in self.open.values()),
                "rent_locked_sol": sum(p.rent_sol for p in self.open.values()),
                "rent_locked_usd": sum(p.rent_sol for p in self.open.values()) * (self.sol_usd or 0.0),
            },
            "started_at": self.started_at,
            "start_equity_usd": self.cfg.start_equity_usd,
            "equity_usd": self.cfg.start_equity_usd + self.realized_usd + unrealized,
            "realized_usd": self.realized_usd,
            "unrealized_usd": unrealized,
            "open_count": len(self.open),
            "closed_count": len(trades),
            "overall": _trade_stats(trades),
            "by_tier": {t: _trade_stats([x for x in trades if x["tier"] == t]) for t in TIER_ORDER},
            "by_strategy": {
                s: _trade_stats([x for x in trades if x["strategy"] == s])
                for s in sorted({x["strategy"] for x in trades})
            },
        })

    async def positions(self, status: str, limit: int, now_ms: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch(
            """select * from paper_positions where status = $1 and profile = $3
               order by coalesce(exit_ts, entry_ts) desc limit $2""",
            status, limit, self.cfg.profile,
        )
        out = []
        for r in rows:
            live = self.open.get(r["id"]) if status == "open" else None
            entry_ts, exit_ts = _ms(r["entry_ts"]), _ms(r["exit_ts"])
            snapshot = _json(r["entry_snapshot"]) or {}
            out.append({
                "id": r["id"], "status": r["status"], "address": r["address"], "name": r["name"],
                "quote_symbol": r["quote_symbol"], "tier": r["tier"], "strategy": r["strategy"], "regime": r["regime"],
                "score": r["score"], "bin_step": r["bin_step"], "entry_ts": entry_ts, "entry_price": r["entry_price"],
                "min_price": r["min_price"], "max_price": r["max_price"], "range_low_pct": r["range_low_pct"],
                "range_high_pct": r["range_high_pct"], "capital_usd": r["capital_usd"],
                "last_price": live.last_price if live else r["last_price"],
                "in_range": live.lp.in_range(live.last_price) if live else None,
                "pnl_pct": live.pnl_pct() if live else r["pnl_pct"],
                "gross_pnl_pct": live.gross_pnl_pct() if live else r["gross_pnl_pct"],
                "cost_pct": live.cost_pct() if live else r["cost_pct"],
                "positions": r["positions"],
                "rent_sol": r["rent_sol"],
                "fee_pct": live.fee_pct() if live else r["fee_pct"],
                "il_pct": live.il_pct() if live else r["il_pct"],
                "hold_hours": ((exit_ts or now_ms) - entry_ts) / HOUR_MS,
                "exit_ts": exit_ts, "exit_price": r["exit_price"], "exit_reason": r["exit_reason"],
                "flags": snapshot.get("flags") or [],
            })
        return _clean(out)

    async def equity(self, hours: float) -> dict[str, Any]:
        rows = await self.db.fetch(
            """select (extract(epoch from ts) * 1000)::bigint as ts, equity_usd, open_count
               from paper_equity where profile = $2 and ts > now() - make_interval(secs => $1) order by ts""",
            hours * 3600, self.cfg.profile,
        )
        step = max(1, math.ceil(len(rows) / MAX_EQUITY_POINTS))
        points = [dict(r) for r in rows[::step]]
        if rows and (not points or points[-1]["ts"] != rows[-1]["ts"]):
            points.append(dict(rows[-1]))
        return _clean({"start_equity_usd": self.cfg.start_equity_usd, "points": points})
