"""Replay recorded data to evaluate the LP plans from app.recommend.

Sources:
- candles (default): 30m OHLCV from the Meteora API (extend history with `npm run backfill` in ingestor).
  Prices are candle closes. Fee rate = candle volume x effective LP fee fraction / TVL, where the fraction is
  the recorded 1h fees/volume nearest in time (captures dynamic fees as they changed; Meteora `fees` already
  exclude the protocol cut), falling back to the pool's 24h fees/volume, then base fee x 90%. Token security
  score/flags are today's values; market flags and regime are recomputed per entry.
- snapshots: prices from price_ticks/pool_snapshots, fee rate from snapshot fees_1h/TVL and the score stored
  at entry time. Finer, but only as old as this system's own recording.

Shared approximations: uniform liquidity across bins; the position earns the pool-average fee/TVL rate while
in range, diluted by its own size; values in the quote token; no tx fees, rent, slippage or rebalancing.

Usage: uv run python -m app.backtest --source candles --hours 48 --every 60
"""

import argparse
import asyncio
import bisect
import json
import math
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from . import config
from .indicators import Candle, compute_indicators, flow_features, merge_market
from .metrics import PriceHistory
from .costs import CostModel, entry_costs, exit_cost, round_trip_cost_pct
from .depth import realization_factor
from .recommend import FEE_RATE_AVG_HOURS, PlanParams, apply_cost_gate, bins_below, bins_for_width, plan_position
from .scoring import MARKET_INFO_FLAGS, MARKET_PENALTIES, diluted_fee_pct, market_flags

HOUR_MS = 3_600_000
CANDLE_MS = 30 * 60_000
MIN_SPACING_MS = 30_000  # downsample ticks
MIN_FORWARD_MS = 30 * 60_000  # need at least this much data after entry
WARMUP_MS = 30 * 60_000  # history before the first entry (volatility / 1h change need it)
INDICATOR_CANDLES = 100
MIN_WARMUP_CANDLES = 40
FLOW_MAX_AGE_MS = 10 * 60_000
CANDLE_HISTORY_SECS = 52 * 3600  # indicator warmup loaded before the backtest window
MIN_UNIVERSE_VOLUME_24H = 50_000  # same floor as the ingestor's MIN_VOLUME_24H screen
MAX_DAILY_TURNOVER = 20.0  # TVL floor = trailing 24h volume / this, so dead pools don't get absurd fee rates


def _geo(r: float, lo: int, hi: int) -> float:
    """sum_{i=lo}^{hi} r^i"""
    n = hi - lo + 1
    if n <= 0:
        return 0.0
    if r == 1:
        return float(n)
    return r**lo * (r**n - 1) / (r - 1)


def _count(lo: int, hi: int) -> int:
    return max(0, hi - lo + 1)


@dataclass
class LpPosition:
    """Uniform-value bins i in [-a, b] around entry price p0, bin i priced p0 * r^i.

    At entry bins below hold quote, bins above hold base, the active bin is split 50/50.
    Each bin's "L" is its value in quote when fully converted at its own price:
    L_i = V for i <= 0, V * r^i for i > 0.
    """

    p0: float
    r: float
    a: int
    b: int
    v: float  # entry value per bin

    @classmethod
    def build(cls, p0: float, bin_step: int, range_low_pct: float, range_high_pct: float, capital: float):
        a = bins_below(-range_low_pct, bin_step)
        b = bins_for_width(range_high_pct, bin_step)
        return cls(p0=p0, r=1 + bin_step / 10_000, a=a, b=b, v=capital / (a + b + 1))

    def _quote(self, lo: int, hi: int) -> float:
        return self.v * _count(lo, min(hi, 0)) + self.v * _geo(self.r, max(lo, 1), hi)

    def _base(self, lo: int, hi: int) -> float:
        # L_i / p_i = V / (p0 r^i) for i <= 0, V / p0 for i > 0
        neg = _geo(self.r, -min(hi, 0), -lo) if lo <= min(hi, 0) else 0.0
        return self.v / self.p0 * (neg + _count(max(lo, 1), hi))

    def _bin_index(self, p: float) -> tuple[int, float]:
        x = math.log(p / self.p0) / math.log(self.r)
        k = math.floor(x + 0.5)
        return k, x - (k - 0.5)  # fraction of bin k already converted to quote

    def in_range(self, p: float) -> bool:
        k, _ = self._bin_index(p)
        return -self.a <= k <= self.b

    def value(self, p: float) -> float:
        k, frac = self._bin_index(p)
        if k < -self.a:
            return p * self._base(-self.a, self.b)
        if k > self.b:
            return self._quote(-self.a, self.b)
        l_k = self.v * (self.r**k if k > 0 else 1.0)
        p_k = self.p0 * self.r**k
        active = l_k * frac + (l_k / p_k) * (1 - frac) * p
        return self._quote(-self.a, k - 1) + p * self._base(k + 1, self.b) + active

    def base_value(self, p: float) -> float:
        """Value (in quote) of the base-token part of the position at price p: what must be swapped out
        to exit fully into the quote token."""
        k, frac = self._bin_index(p)
        if k < -self.a:
            return p * self._base(-self.a, self.b)
        if k > self.b:
            return 0.0
        l_k = self.v * (self.r**k if k > 0 else 1.0)
        p_k = self.p0 * self.r**k
        return p * self._base(k + 1, self.b) + (l_k / p_k) * (1 - frac) * p

    def hodl_value(self, p: float) -> float:
        base0 = (self.b * self.v + self.v / 2) / self.p0
        quote0 = self.a * self.v + self.v / 2
        return quote0 + base0 * p


# Same cost assumptions as paper trading (no bin array rent: historical bin arrays are unknown).
BACKTEST_COSTS = CostModel(
    enabled=config.PAPER_COSTS_ENABLED,
    tx_cost_sol=config.PAPER_TX_COST_SOL,
    impact_multiplier=config.PAPER_IMPACT_MULTIPLIER,
    exit_swap_share=config.PAPER_EXIT_SWAP_SHARE,
)


def simulate(
    series: list[tuple[int, float]],
    start: int,
    fee_rate_at,  # (ts_ms) -> (fraction of TVL per hour, tvl)
    capital: float,
    bin_step: int,
    plan: dict[str, Any],
    cost_model: CostModel | None = None,
    pool_ctx: dict[str, Any] | None = None,
    sol_usd: float = 150.0,
) -> dict[str, Any]:
    """Same exit rules, in the same order, as app.paper.exit_reason. With `cost_model`, the stop-loss and the
    returned `return_pct` are net of entry and exit costs (capital in USD; `pool_ctx` gives base/dynamic fee)."""
    ts0, p0 = series[start]
    pos = LpPosition.build(p0, bin_step, plan["range_low_pct"], plan["range_high_pct"], capital)
    rules = plan["exit"]
    min_hold = rules.get("min_hold_hours") or 0.0
    positions = int(plan.get("positions") or 1)
    entry_rate, tvl0 = fee_rate_at(ts0)
    ctx = dict(pool_ctx or {}, tvl=tvl0)
    entry_cost = entry_costs(pos, positions, ctx, 1.0, sol_usd, cost_model)[0] if cost_model else 0.0
    exit_c = 0.0
    avg_samples = int(FEE_RATE_AVG_HOURS * 2) + 1
    realization = realization_factor(pos.a + pos.b + 1)  # same calibrated fee model as paper trading

    def avg_rate(ts: int) -> float:
        return sum(fee_rate_at(ts - k * HOUR_MS // 2)[0] for k in range(avg_samples)) / avg_samples
    breakout_low = p0 * (1 + rules["breakout_below_pct"] / 100) if rules.get("breakout_below_pct") is not None else None
    breakout_high = p0 * (1 + rules["breakout_above_pct"] / 100) if rules.get("breakout_above_pct") is not None else None

    fees = 0.0
    prev_ts, prev_p, prev_value = ts0, p0, capital
    out_since: int | None = None
    reason = "end_of_data"
    ts, p, value = ts0, p0, capital

    for ts, p in series[start + 1 :]:
        rate, tvl = fee_rate_at(prev_ts)
        if rate > 0 and pos.in_range(prev_p):
            fees += prev_value * rate * (ts - prev_ts) / HOUR_MS * (tvl / (tvl + capital) if tvl > 0 else 0) * realization
        value = pos.value(p)
        if cost_model:
            exit_c = exit_cost(pos, p, positions, dict(ctx, tvl=tvl or tvl0), 1.0, sol_usd, cost_model)
        pnl_pct = (value + fees - capital - entry_cost - exit_c) / capital * 100
        held_h = (ts - ts0) / HOUR_MS
        out_since = None if pos.in_range(p) else (out_since or ts)

        if pnl_pct <= -rules["stop_loss_pct"]:
            reason = "stop_loss"
            break
        if out_since is not None and (ts - out_since) / 60_000 >= rules["out_of_range_minutes"]:
            reason = "out_of_range"
            break
        if held_h < min_hold:
            prev_ts, prev_p, prev_value = ts, p, value
            continue
        if (breakout_low is not None and p < breakout_low) or (breakout_high is not None and p > breakout_high):
            reason = "breakout"
            break
        if held_h >= 1 and entry_rate > 0 and avg_rate(ts) < entry_rate * rules["fee_decay_ratio"]:
            reason = "fee_decay"
            break
        if held_h >= rules["max_hold_hours"]:
            reason = "max_hold"
            break
        prev_ts, prev_p, prev_value = ts, p, value

    return {
        "entry_ts": ts0,
        "exit_ts": ts,
        "hold_hours": (ts - ts0) / HOUR_MS,
        "exit_reason": reason,
        "price_change_pct": (p / p0 - 1) * 100,
        "fee_pct": fees / capital * 100,
        "il_vs_hodl_pct": (value - pos.hodl_value(p)) / capital * 100,
        "gross_return_pct": (value + fees - capital) / capital * 100,
        "cost_pct": (entry_cost + exit_c) / capital * 100,
        "return_pct": (value + fees - capital - entry_cost - exit_c) / capital * 100,
    }


SOL_MINT = "So11111111111111111111111111111111111111112"
USD_MINTS = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
}


def quote_usd_factor(
    quote_mint: str | None, sol_usd: tuple[list[int], list[float]], entry_ts: int, exit_ts: int
) -> float | None:
    """How much a unit of the quote token gained in USD between entry and exit: 1 for USD stablecoins, the SOL
    price ratio for SOL, None for other quotes or when the SOL series does not cover the trade."""
    if quote_mint in USD_MINTS:
        return 1.0
    if quote_mint != SOL_MINT:
        return None
    ts, prices = sol_usd
    if not ts or entry_ts < ts[0] or exit_ts < ts[0]:
        return None

    def price_at(t: int) -> float:
        return prices[max(0, bisect.bisect_right(ts, t) - 1)]

    start = price_at(entry_ts)
    return price_at(exit_ts) / start if start > 0 else None


def summarize(trades: list[dict[str, Any]]) -> dict[str, Any]:
    if not trades:
        return {"trades": 0}
    returns = sorted(t["return_pct"] for t in trades)
    return {
        "trades": len(trades),
        "win_rate_pct": round(sum(r > 0 for r in returns) / len(returns) * 100, 1),
        "mean_return_pct": round(statistics.fmean(returns), 3),
        "median_return_pct": round(statistics.median(returns), 3),
        "p10_return_pct": round(returns[max(0, math.ceil(len(returns) * 0.1) - 1)], 3),
        "worst_return_pct": round(returns[0], 3),
        "mean_fee_pct": round(statistics.fmean(t["fee_pct"] for t in trades), 3),
        "mean_il_vs_hodl_pct": round(statistics.fmean(t["il_vs_hodl_pct"] for t in trades), 3),
        "mean_hold_hours": round(statistics.fmean(t["hold_hours"] for t in trades), 2),
        "exit_reasons": dict(Counter(t["exit_reason"] for t in trades)),
        **(
            {
                "usd_trades": len(usd),
                "mean_return_usd_pct": round(statistics.fmean(usd), 3),
                "median_return_usd_pct": round(statistics.median(usd), 3),
            }
            if (usd := [t["return_usd_pct"] for t in trades if t.get("return_usd_pct") is not None])
            else {}
        ),
        **(
            {
                "mean_cost_pct": round(statistics.fmean(t["cost_pct"] for t in trades), 3),
                "mean_gross_return_pct": round(statistics.fmean(t["gross_return_pct"] for t in trades), 3),
            }
            if all("cost_pct" in t and "gross_return_pct" in t for t in trades)
            else {}
        ),
    }


def score_bucket(score: float) -> str:
    if score < 55:
        return "<55"
    if score < 65:
        return "55-65"
    if score < 75:
        return "65-75"
    return "75+"


def _downsample(points: list[tuple[int, float]]) -> list[tuple[int, float]]:
    out: list[tuple[int, float]] = []
    for ts, price in points:
        if price > 0 and (not out or ts - out[-1][0] >= MIN_SPACING_MS):
            out.append((ts, price))
    return out


# Meteora's `fees` are already the LP share: protocol fees are reported separately and observed at ~10% of
# total swap fees (even where pool_config says 5%). Used only when no observed fee/volume ratio exists.
LP_SHARE_FALLBACK = 0.90
MAX_LP_FEE_FRACTION = 0.10  # guard against noisy windows (fees on near-zero volume)
MIN_WINDOW_VOLUME_USD = 1_000.0
FEE_SNAPSHOT_MAX_GAP_MS = 90 * 60_000


def lp_fee_fraction(fees: float | None, volume: float | None, base_fee_pct: float | None) -> float:
    """LP fee earned per unit of swap volume. Observed fees/volume already include dynamic fees and exclude
    the protocol cut; without observations fall back to the base fee times the typical LP share."""
    if fees and volume and volume >= MIN_WINDOW_VOLUME_USD and fees > 0:
        return min(fees / volume, MAX_LP_FEE_FRACTION)
    return (base_fee_pct or 0.0) / 100 * LP_SHARE_FALLBACK


@dataclass
class FeeSeries:
    """Effective LP fee fraction over time for one pool, from recorded 1h fee/volume snapshots."""

    ts: list[int]
    fractions: list[float]
    fallback: float

    def at(self, ts: int) -> float:
        """Nearest snapshot within FEE_SNAPSHOT_MAX_GAP_MS, else the pool's 24h fallback. Dynamic fees change
        with volatility, so a fixed per-pool multiplier from today would misprice older candles."""
        i = bisect.bisect_left(self.ts, ts)
        best: int | None = None
        for j in (i - 1, i):
            if 0 <= j < len(self.ts) and (best is None or abs(self.ts[j] - ts) < abs(self.ts[best] - ts)):
                best = j
        if best is not None and abs(self.ts[best] - ts) <= FEE_SNAPSHOT_MAX_GAP_MS:
            return self.fractions[best]
        return self.fallback


def entry_flags_and_safety(
    stored_flags: list[str], stored_safety: float, market: dict[str, Any] | None, change_1h: float | None
) -> tuple[list[str], float]:
    """Swap the market-derived part of stored flags/safety for values computed at entry time."""
    stored_market_penalty = sum(MARKET_PENALTIES.get(f, 0.0) for f in stored_flags)
    token_flags = [f for f in stored_flags if f not in MARKET_PENALTIES and f not in MARKET_INFO_FLAGS]
    entry_market = market_flags(market, change_1h)
    safety = stored_safety + stored_market_penalty - sum(MARKET_PENALTIES.get(f, 0.0) for f in entry_market)
    return token_flags + entry_market, max(0.0, min(30.0, safety))


class MarketHistory:
    """Candles and flow snapshots per pool, queried as of a timestamp."""

    def __init__(self, candle_rows, flow_rows):
        self.candles: defaultdict[str, list[Candle]] = defaultdict(list)
        for r in candle_rows:
            self.candles[r["address"]].append(
                Candle(r["ts_ms"], r["open"], r["high"], r["low"], r["close"], r["volume"])
            )
        self.close_times = {a: [c.ts + CANDLE_MS for c in cs] for a, cs in self.candles.items()}
        self.flows: defaultdict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
        for r in flow_rows:
            data = r["data"] if isinstance(r["data"], dict) else json.loads(r["data"])
            self.flows[r["address"]].append((r["ts_ms"], data))
        self.flow_times = {a: [f[0] for f in fs] for a, fs in self.flows.items()}

    def market_at(self, address: str, ts: int) -> dict[str, Any] | None:
        candles = self.candles.get(address, [])
        end = bisect.bisect_right(self.close_times.get(address, []), ts)  # closed candles only
        indicators = compute_indicators(candles[max(0, end - INDICATOR_CANDLES) : end])
        flow = None
        fi = bisect.bisect_right(self.flow_times.get(address, []), ts) - 1
        if fi >= 0 and ts - self.flows[address][fi][0] <= FLOW_MAX_AGE_MS:
            flow = flow_features(self.flows[address][fi][1])
        return merge_market(indicators, flow)


async def _load_market_history(conn, secs: float) -> MarketHistory:
    candle_rows = await conn.fetch(
        """select address, (extract(epoch from ts) * 1000)::bigint as ts_ms, open, high, low, close, volume
           from candles where timeframe = '30m' and ts > now() - make_interval(secs => $1) order by address, ts""",
        secs + CANDLE_HISTORY_SECS,
    )
    flow_rows = await conn.fetch(
        """select address, (extract(epoch from ts) * 1000)::bigint as ts_ms, data
           from pool_flow where ts > now() - make_interval(secs => $1) order by address, ts""",
        secs,
    )
    return MarketHistory(candle_rows, flow_rows)


GROUP_ORDER = {"low": 0, "medium": 1, "high": 2}


def _group_trades(trades: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for tr in trades:
        groups[str(tr.get(key) or "unknown")].append(tr)
    ordered = sorted(groups.items(), key=lambda kv: (GROUP_ORDER.get(kv[0], 99), kv[0]))
    return {k: summarize(v) for k, v in ordered}


def _report(source: str, hours: float, every: float, capital: float, trades, skipped, with_score: bool):
    if trades and "capital_usd" in trades[0]:
        capital = statistics.fmean(t["capital_usd"] for t in trades)
    report = {
        "source": source,
        "hours": hours,
        "every_minutes": every,
        "capital_per_trade": capital,
        "pools": len({tr["address"] for tr in trades}),
        "skipped_entries": dict(skipped),
        "overall": summarize(trades),
        "by_regime": _group_trades(trades, "regime"),
        "by_tier": _group_trades(trades, "tier"),
        "by_strategy": _group_trades(trades, "strategy"),
    }
    if with_score:
        for tr in trades:
            tr["score_bucket"] = score_bucket(tr["score"])
        report["by_score"] = _group_trades(trades, "score_bucket")
    return report


async def _run_snapshots(pool: asyncpg.Pool, hours: float, every_minutes: float, params: PlanParams) -> dict[str, Any]:
    secs = hours * 3600
    async with pool.acquire() as conn:
        bin_steps = {r["address"]: r["bin_step"] for r in await conn.fetch("select address, bin_step from pools")}
        tick_rows = await conn.fetch(
            """select address, (extract(epoch from ts) * 1000)::bigint as ts_ms, price
               from price_ticks where ts > now() - make_interval(secs => $1) order by ts""",
            secs,
        )
        snap_rows = await conn.fetch(
            """select address, (extract(epoch from ts) * 1000)::bigint as ts_ms, price, fees_1h, tvl
               from pool_snapshots where ts > now() - make_interval(secs => $1) order by ts""",
            secs,
        )
        metric_rows = await conn.fetch(
            """select address, (extract(epoch from ts) * 1000)::bigint as ts_ms, score,
                      coalesce(safety, 15) as safety, flags
               from pool_metrics where ts > now() - make_interval(secs => $1) order by ts""",
            secs,
        )
        history = await _load_market_history(conn, secs)

    ticks: defaultdict[str, list[tuple[int, float]]] = defaultdict(list)
    for r in tick_rows:
        ticks[r["address"]].append((r["ts_ms"], r["price"]))
    snaps: defaultdict[str, list[tuple[int, float, float, float]]] = defaultdict(list)
    for r in snap_rows:
        snaps[r["address"]].append((r["ts_ms"], r["price"], r["fees_1h"] or 0.0, r["tvl"] or 0.0))
    metrics: defaultdict[str, list[tuple[int, float, float, list[str]]]] = defaultdict(list)
    for r in metric_rows:
        metrics[r["address"]].append((r["ts_ms"], r["score"], r["safety"], list(r["flags"])))

    trades: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    capital = params.portfolio_usd * params.max_position_pct / 100

    for address, snap in snaps.items():
        bin_step = bin_steps.get(address)
        pool_metrics = metrics.get(address)
        if not bin_step or not pool_metrics:
            continue
        series = _downsample(ticks[address] if len(ticks[address]) >= 10 else [(s[0], s[1]) for s in snap])
        if len(series) < 10:
            continue
        series_ts = [s[0] for s in series]
        snap_ts = [s[0] for s in snap]
        metric_ts = [m[0] for m in pool_metrics]

        def fee_rate_at(ts: int, snap=snap, snap_ts=snap_ts) -> tuple[float, float]:
            i = bisect.bisect_right(snap_ts, ts) - 1
            if i < 0:
                return 0.0, 0.0
            _, _, fees_1h, tvl = snap[i]
            return (fees_1h / tvl if tvl > 0 else 0.0), tvl

        t = series_ts[0] + WARMUP_MS
        while t <= series_ts[-1] - MIN_FORWARD_MS:
            start = bisect.bisect_left(series_ts, t)
            mi = bisect.bisect_right(metric_ts, series_ts[start]) - 1
            t += every_minutes * 60_000
            if mi < 0:
                skipped["no_score"] += 1
                continue
            entry_ts = series_ts[start]
            price_history = PriceHistory()
            for ts, price in series[bisect.bisect_left(series_ts, entry_ts - HOUR_MS) : start + 1]:
                price_history.add(ts, price, 2 * HOUR_MS)
            _, score, safety, stored_flags = pool_metrics[mi]
            market = history.market_at(address, entry_ts)
            change = price_history.change_pct(entry_ts, HOUR_MS)
            flags, safety = entry_flags_and_safety(stored_flags, safety, market, change)
            rate, tvl = fee_rate_at(entry_ts)
            plan = plan_position(
                bin_step=bin_step,
                tvl=tvl,
                score=score,
                safety=safety,
                flags=flags,
                change_pct_1h=change,
                realized_vol_pct_1h=price_history.realized_vol_pct(entry_ts, HOUR_MS),
                fee_for_position_pct_day=diluted_fee_pct(rate * 24 * 100, tvl, capital),
                params=params,
                market=market,
            )
            if plan["action"] in ("avoid", "wait"):
                skipped[plan["action"]] += 1
                continue
            trade = simulate(series, start, fee_rate_at, capital, bin_step, plan)
            trade.update(
                address=address, score=score, tier=plan["tier"],
                strategy=plan["strategy"], regime=plan["regime"],
            )
            trades.append(trade)

    return _report("snapshots", hours, every_minutes, capital, trades, skipped, with_score=True)


@dataclass
class CandleData:
    """Everything the candle backtest reads from the DB, loaded once and reusable across rule variants."""

    hours: float
    loaded_at_ms: int
    pools: dict[str, Any]
    tvls: dict[str, float]
    fee_series: dict[str, FeeSeries]
    latest: dict[str, Any]
    history: MarketHistory
    market_cache: dict[tuple[str, int], dict[str, Any] | None]
    sol_usd: tuple[list[int], list[float]] = field(default_factory=lambda: ([], []))  # candle open ts, SOL price

    @property
    def window_start_ms(self) -> int:
        return self.loaded_at_ms - int(self.hours * HOUR_MS)


async def load_candle_data(pool: asyncpg.Pool, hours: float) -> CandleData:
    secs = hours * 3600
    async with pool.acquire() as conn:
        pools = {
            r["address"]: r
            for r in await conn.fetch("select address, bin_step, base_fee_pct, mint_x, mint_y from pools")
        }
        # SOL/USD from the SOL-USDC(T) pool with the longest candle history, to value SOL-quoted trades in USD.
        sol_ref = await conn.fetchval(
            """select c.address from candles c join pools p on p.address = c.address
               where c.timeframe = '30m' and p.mint_x = $1 and p.mint_y = any($2::text[])
               group by c.address order by count(*) desc limit 1""",
            SOL_MINT, list(USD_MINTS),
        )
        sol_rows = await conn.fetch(
            """select (extract(epoch from ts) * 1000)::bigint as ts_ms, close from candles
               where address = $1 and timeframe = '30m' and ts > now() - make_interval(secs => $2) order by ts""",
            sol_ref, secs + CANDLE_HISTORY_SECS,
        ) if sol_ref else []
        # Snapshots may be missing for backfilled pools (e.g. dead ones); they get the TVL floor instead.
        snapshots = await conn.fetch(
            """select distinct on (address) address, tvl, volume_24h, fees_24h
               from pool_snapshots order by address, ts desc"""
        )
        latest = {
            r["address"]: r
            for r in await conn.fetch(
                """select distinct on (address) address, score, coalesce(safety, 15) as safety, flags
                   from pool_metrics order by address, ts desc"""
            )
        }
        history = await _load_market_history(conn, secs)
        fee_rows = await conn.fetch(
            """select address, (extract(epoch from ts) * 1000)::bigint as ts_ms, fees_1h, volume_1h
               from pool_snapshots
               where ts > now() - make_interval(secs => $1) and volume_1h >= $2 and fees_1h > 0
               order by address, ts""",
            secs + CANDLE_HISTORY_SECS,
            MIN_WINDOW_VOLUME_USD,
        )
    fallbacks = {
        r["address"]: lp_fee_fraction(
            r["fees_24h"], r["volume_24h"], pools[r["address"]]["base_fee_pct"] if r["address"] in pools else None
        )
        for r in snapshots
    }
    series_points: defaultdict[str, tuple[list[int], list[float]]] = defaultdict(lambda: ([], []))
    for r in fee_rows:
        ts_list, fractions = series_points[r["address"]]
        ts_list.append(r["ts_ms"])
        fractions.append(lp_fee_fraction(r["fees_1h"], r["volume_1h"], None))
    fee_series = {
        address: FeeSeries(
            ts=series_points[address][0],
            fractions=series_points[address][1],
            fallback=fallbacks.get(
                address, lp_fee_fraction(None, None, pools[address]["base_fee_pct"] if address in pools else None)
            ),
        )
        for address in set(fallbacks) | set(series_points) | set(history.candles)
    }
    return CandleData(
        hours=hours,
        loaded_at_ms=int(time.time() * 1000),
        pools=pools,
        tvls={r["address"]: r["tvl"] or 0.0 for r in snapshots},
        fee_series=fee_series,
        latest=latest,
        history=history,
        market_cache={},
        sol_usd=([r["ts_ms"] for r in sol_rows], [r["close"] for r in sol_rows]),
    )


def trade_size(plan_size_usd: float, tvl: float, params: PlanParams) -> float:
    """Position size for a backtest trade, sized like paper trading: the plan's size, floored, then capped by
    the share of TVL. Returns 0 when the result is below the minimum position size."""
    size = max(plan_size_usd, params.position_floor_usd)
    if tvl > 0:
        size = min(size, tvl * params.max_tvl_share)
    return size if size >= params.min_position_usd else 0.0


def simulate_candle_trades(
    data: CandleData, every_minutes: float, params: PlanParams, min_volume_24h: float = MIN_UNIVERSE_VOLUME_24H
) -> tuple[list[dict[str, Any]], Counter[str]]:
    """Survivorship-aware: a pool enters the universe at a given time only if its trailing 24h candle volume
    passed the screener floor *then*, whatever it looks like today. Pools without today's snapshot/score
    (e.g. dead pools from a backfill) still trade, with neutral safety and no token flags."""
    trades: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    capital = params.portfolio_usd * params.max_position_pct / 100
    step = max(1, round(every_minutes * 60_000 / CANDLE_MS))
    history = data.history
    day_candles = int(24 * HOUR_MS / CANDLE_MS)

    for address, candles in history.candles.items():
        info = data.pools.get(address)
        if not info or len(candles) < MIN_WARMUP_CANDLES + 2:
            continue
        stored = data.latest.get(address)
        score, stored_safety, stored_flags = (
            (stored["score"], stored["safety"], list(stored["flags"])) if stored else (0.0, 15.0, [])
        )
        close_times = history.close_times[address]
        series = [(ct, c.close) for ct, c in zip(close_times, candles)]
        volume_prefix = [0.0]
        for c in candles:
            volume_prefix.append(volume_prefix[-1] + c.volume)
        fees = data.fee_series.get(address) or FeeSeries([], [], lp_fee_fraction(None, None, info["base_fee_pct"]))
        tvl_now = data.tvls.get(address, 0.0)

        def tvl_at(i: int) -> float:
            # Historical TVL is unknown: today's TVL, floored so turnover never exceeds MAX_DAILY_TURNOVER.
            trailing = volume_prefix[i + 1] - volume_prefix[max(0, i + 1 - day_candles)]
            return max(tvl_now, trailing / MAX_DAILY_TURNOVER)

        def fee_rate_at(ts: int, candles=candles, close_times=close_times, fees=fees, tvl_at=tvl_at):
            i = min(bisect.bisect_right(close_times, ts), len(candles) - 1)  # candle in progress at ts
            tvl = tvl_at(i)
            if tvl <= 0:
                return 0.0, tvl
            return candles[i].volume * fees.at(ts) * (HOUR_MS / CANDLE_MS) / tvl, tvl

        first = max(MIN_WARMUP_CANDLES, bisect.bisect_left(close_times, data.window_start_ms))
        for start in range(first, len(series) - 2, step):
            trailing_volume = volume_prefix[start + 1] - volume_prefix[max(0, start + 1 - day_candles)]
            if trailing_volume < min_volume_24h:
                skipped["universe"] += 1
                continue
            entry_ts = series[start][0]
            key = (address, entry_ts)
            if key not in data.market_cache:
                data.market_cache[key] = history.market_at(address, entry_ts)
            market = data.market_cache[key]
            change = (market or {}).get("change_1h_pct")
            flags, safety = entry_flags_and_safety(stored_flags, stored_safety, market, change)
            rate, tvl = fee_rate_at(entry_ts - 1)
            plan = plan_position(
                bin_step=info["bin_step"],
                tvl=tvl,
                score=score,
                safety=safety,
                flags=flags,
                change_pct_1h=change,
                realized_vol_pct_1h=None,
                fee_for_position_pct_day=diluted_fee_pct(rate * 24 * 100, tvl, capital),
                params=params,
                market=market,
            )
            if plan["action"] in ("avoid", "wait"):
                skipped[plan["action"]] += 1
                continue
            size = trade_size(plan["size_usd"], tvl, params)
            if size <= 0:
                skipped["below_min_size"] += 1
                continue
            ctx = {"base_fee_pct": info["base_fee_pct"], "dynamic_fee_pct": 0.0, "tvl": tvl}
            if BACKTEST_COSTS.enabled:
                lp = LpPosition.build(series[start][1], info["bin_step"], plan["range_low_pct"], plan["range_high_pct"], size)
                cost_pct = round_trip_cost_pct(lp, int(plan.get("positions") or 1), ctx, 1.0, config.SOL_USD_FALLBACK,
                                               BACKTEST_COSTS)
                fee_pct_day = diluted_fee_pct(rate * 24 * 100, tvl, size) * realization_factor(int(plan["bins"]))
                plan = apply_cost_gate(plan, cost_pct, fee_pct_day, params)
                if plan["action"] != "enter":
                    skipped["fee_below_cost"] += 1
                    continue
            trade = simulate(series, start, fee_rate_at, size, info["bin_step"], plan,
                             BACKTEST_COSTS if BACKTEST_COSTS.enabled else None, ctx, config.SOL_USD_FALLBACK)
            trade.update(
                address=address, score=score, tier=plan["tier"], strategy=plan["strategy"],
                regime=plan["regime"], scored=stored is not None, capital_usd=size,
            )
            factor = quote_usd_factor(info["mint_y"], data.sol_usd, trade["entry_ts"], trade["exit_ts"])
            if factor is not None:
                trade["quote_usd_change_pct"] = (factor - 1) * 100
                trade["return_usd_pct"] = ((1 + trade["return_pct"] / 100) * factor - 1) * 100
            trades.append(trade)
    return trades, skipped


def evaluate_candles(data: CandleData, every_minutes: float, params: PlanParams) -> dict[str, Any]:
    trades, skipped = simulate_candle_trades(data, every_minutes, params)
    capital = params.portfolio_usd * params.max_position_pct / 100
    # Scores are today's, not as of entry, so no per-score grouping for this source.
    return _report("candles", data.hours, every_minutes, capital, trades, skipped, with_score=False)


async def _run_candles(pool: asyncpg.Pool, hours: float, every_minutes: float, params: PlanParams) -> dict[str, Any]:
    return evaluate_candles(await load_candle_data(pool, hours), every_minutes, params)


async def run_backtest(
    pool: asyncpg.Pool, hours: float, every_minutes: float, params: PlanParams, source: str = "candles"
) -> dict[str, Any]:
    if source == "snapshots":
        return await _run_snapshots(pool, hours, every_minutes, params)
    if source == "candles":
        return await _run_candles(pool, hours, every_minutes, params)
    raise ValueError(f"unknown source: {source}")


def default_params() -> PlanParams:
    return PlanParams(
        portfolio_usd=config.PAPER_START_EQUITY_USD,
        max_position_pct=config.MAX_POSITION_PCT,
        hold_hours=config.HOLD_HOURS,
        # Paper trading is the reference: same equity, floor and minimum, so backtest and paper size alike.
        position_floor_usd=config.PAPER_POSITION_FLOOR_USD,
        min_position_usd=config.PAPER_MIN_POSITION_USD,
        min_hold_hours=config.MIN_HOLD_HOURS,
        min_fee_cost_ratio=config.MIN_FEE_COST_RATIO,
        max_round_trip_cost_pct=config.MAX_ROUND_TRIP_COST_PCT,
        max_stop_loss_pct=config.MAX_STOP_LOSS_PCT,
        fee_gate_hours=config.FEE_GATE_HOURS,
    )


def _print_report(report: dict[str, Any]) -> None:
    print(
        f"Backtest [{report['source']}] {report['hours']}h, entry tiap {report['every_minutes']} menit, "
        f"modal/trade {report['capital_per_trade']:.0f} (unit quote), {report['pools']} pool"
    )
    print(f"entry dilewati: {report['skipped_entries']}")
    header = f"{'grup':<15}{'trade':>6}{'win%':>7}{'mean%':>9}{'median%':>9}{'p10%':>9}{'fee%':>8}{'IL%':>8}{'jam':>6}"

    def table(title: str, groups: dict[str, dict[str, Any]]) -> None:
        print(f"\n{title}\n{header}")
        for name, s in groups.items():
            if not s.get("trades"):
                continue
            print(
                f"{name:<15}{s['trades']:>6}{s['win_rate_pct']:>7.1f}{s['mean_return_pct']:>9.2f}"
                f"{s['median_return_pct']:>9.2f}{s['p10_return_pct']:>9.2f}{s['mean_fee_pct']:>8.2f}"
                f"{s['mean_il_vs_hodl_pct']:>8.2f}{s['mean_hold_hours']:>6.1f}"
            )

    table("Keseluruhan", {"semua": report["overall"]})
    table("Per rezim", report["by_regime"])
    if "by_score" in report:
        table("Per skor", report["by_score"])
    table("Per tier risiko", report["by_tier"])
    table("Per strategi", report["by_strategy"])
    if report["overall"].get("trades"):
        print(f"\nalasan exit: {report['overall']['exit_reasons']}")


async def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", choices=["candles", "snapshots"], default="candles")
    parser.add_argument("--hours", type=float, default=48)
    parser.add_argument("--every", type=float, default=60, help="menit antar entry per pool")
    args = parser.parse_args()
    pool = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=2, **config.DB_CONNECT_KWARGS)
    try:
        _print_report(await run_backtest(pool, args.hours, args.every, default_params(), args.source))
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(_main())
