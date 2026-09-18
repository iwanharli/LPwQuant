"""Backtest for a swap bot: buy a token on a momentum signal, sell it at a target, a stop, or a time limit.

This is a directional bet, not the LP market making the rest of the engine does. It is measured here because the
question keeps coming up, and because the same 30 days of candles can answer it.

What the numbers already say before running it: over 76,595 samples no indicator in this system pushed the odds
of a higher price 4h later past ~46% (baseline 41.6% up / 44.3% down). Direction is not predictable from what we
have. Magnitude is (ATR), and the forward distribution has a fat right tail -- mean +0.81% against a median of
0.00% -- which is what a momentum bot lives on. So the real question is whether that tail survives two swaps.

Honest by construction:
- Fills are candle closes only. Using intraday high/low to decide a target was hit would let the simulator exit
  at prices the bot could not have seen coming, and flatters every target-based rule.
- Every trade pays the pool fee plus price impact twice (buy and sell), from the same cost model as the LP side.
- Each variant is compared against buying the same tokens at the same moments and simply holding to the time
  limit, so a rising market cannot be mistaken for a working signal.
- Confidence intervals bootstrap by pool, not by trade: trades in one pool are not independent samples.

Conclusion (Sept 2026, 30 days of candles): all 9 variants lose after costs. The one with a positive mean,
buying after a dump, is a lottery ticket: its median trade at 8h is -2.87%, and the top 1% of trades supply 67%
of the profit. It also looks better than it is, because pools that rugged are missing from the data and the TVL
filter uses today's values. The swap-bot idea is closed; the dashboard page was removed. Keep this module to
re-test if the data or the cost model changes.

Usage: uv run python -m app.momentum --hours 720
"""

import argparse
import asyncio
import json
import random
import statistics
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

import asyncpg

from . import config
from .backtest import (
    CANDLE_MS,
    HOUR_MS,
    MIN_UNIVERSE_VOLUME_24H,
    MIN_WARMUP_CANDLES,
    CandleData,
    load_candle_data,
)
from .costs import CostModel, swap_cost_fraction

CANDLES_PER_HOUR = 2
COSTS = CostModel(enabled=True, tx_cost_sol=config.PAPER_TX_COST_SOL, impact_multiplier=config.PAPER_IMPACT_MULTIPLIER)


@dataclass(frozen=True)
class SwapParams:
    signal: str = "breakout"
    size_usd: float = 100.0
    target_pct: float = 10.0
    stop_pct: float = -10.0
    max_hold_hours: float = 8.0
    entry_every_minutes: float = 60.0
    label: str = ""


def signal_fires(name: str, market: dict[str, Any] | None, closes: list[float], i: int) -> bool:
    """Entry signals built only from indicators this system already computes."""
    m = market or {}
    if name == "always":  # control: no signal at all, enter whenever asked
        return True
    if name == "breakout":  # price above the highest close of the last 24h
        window = closes[max(0, i - 48) : i]
        return bool(window) and closes[i] > max(window)
    if name == "momentum_1h":
        return (m.get("change_1h_pct") or 0.0) >= 5.0
    if name == "trend":
        return m.get("regime") == "trending_up" and (m.get("adx") or 0.0) >= 25
    if name == "dip":  # oversold bounce: the one bucket that was >50% up was after a hard dump
        return (m.get("change_1h_pct") or 0.0) <= -10.0
    if name == "squeeze_break":
        window = closes[max(0, i - 48) : i]
        return bool(m.get("bb_squeeze")) and bool(window) and closes[i] > max(window)
    raise ValueError(f"unknown signal: {name}")


def round_trip_cost_pct(pool: dict[str, Any], size_usd: float) -> float:
    """Buy and sell: the pool fee plus price impact, charged on both legs."""
    return 2 * swap_cost_fraction(pool, size_usd, COSTS) * 100


def simulate(data: CandleData, params: SwapParams) -> list[dict[str, Any]]:
    h = data.history
    step = max(1, round(params.entry_every_minutes * 60_000 / CANDLE_MS))
    hold_candles = max(1, int(params.max_hold_hours * CANDLES_PER_HOUR))
    day = int(24 * HOUR_MS / CANDLE_MS)
    trades: list[dict[str, Any]] = []

    for address, candles in h.candles.items():
        info = data.pools.get(address)
        if not info:
            continue
        closes = [c.close for c in candles]
        times = h.close_times[address]
        tvl = data.tvls.get(address, 0.0)
        pool = {"base_fee_pct": info["base_fee_pct"], "dynamic_fee_pct": 0.0, "tvl": tvl,
                "bin_step": info["bin_step"]}
        cost_pct = round_trip_cost_pct(pool, params.size_usd)

        for i in range(MIN_WARMUP_CANDLES, len(closes) - hold_candles, step):
            volume_24h = sum(c.volume for c in candles[max(0, i - day) : i])
            if volume_24h < MIN_UNIVERSE_VOLUME_24H:
                continue  # same universe floor as the LP backtest, applied as of this moment
            key = (address, times[i])  # shared across variants: nine variants used to recompute every indicator
            if key not in data.market_cache:
                data.market_cache[key] = h.market_at(address, times[i])
            market = data.market_cache[key]
            if not signal_fires(params.signal, market, closes, i):
                continue
            entry = closes[i]
            if entry <= 0:
                continue
            exit_i, reason = i + hold_candles, "time"
            for j in range(i + 1, i + hold_candles + 1):
                move = (closes[j] / entry - 1) * 100
                if move <= params.stop_pct:
                    exit_i, reason = j, "stop"
                    break
                if move >= params.target_pct:
                    exit_i, reason = j, "target"
                    break
            gross = (closes[exit_i] / entry - 1) * 100
            hold_gross = (closes[i + hold_candles] / entry - 1) * 100  # same entry, no target or stop
            trades.append({
                "address": address, "entry_ts": times[i], "hold_hours": (exit_i - i) / CANDLES_PER_HOUR,
                "gross_pct": gross, "cost_pct": cost_pct, "net_pct": gross - cost_pct,
                "hold_net_pct": hold_gross - cost_pct, "reason": reason,
                "atr_pct": (market or {}).get("atr_pct"),
            })
    return trades


def bootstrap_by_pool(values_by_pool: dict[str, list[float]], n: int = 2000, seed: int = 13) -> tuple[float, float, float]:
    keys = list(values_by_pool)
    flat = [v for k in keys for v in values_by_pool[k]]
    if not flat:
        return float("nan"), float("nan"), float("nan")
    rnd, means = random.Random(seed), []
    for _ in range(n):
        vals: list[float] = []
        for _ in keys:
            vals.extend(values_by_pool[rnd.choice(keys)])
        means.append(statistics.fmean(vals))
    means.sort()
    return statistics.fmean(flat), means[int(n * 0.025)], means[int(n * 0.975)]


def summarize(trades: list[dict[str, Any]], params: SwapParams) -> dict[str, Any]:
    if not trades:
        return {"label": params.label or params.signal, "trades": 0}
    by_pool: dict[str, list[float]] = defaultdict(list)
    hold_by_pool: dict[str, list[float]] = defaultdict(list)
    for t in trades:
        by_pool[t["address"]].append(t["net_pct"])
        hold_by_pool[t["address"]].append(t["hold_net_pct"])
    mean, lo, hi = bootstrap_by_pool(by_pool)
    hold_mean, hold_lo, hold_hi = bootstrap_by_pool(hold_by_pool)
    nets = sorted(t["net_pct"] for t in trades)
    reasons: dict[str, int] = defaultdict(int)
    for t in trades:
        reasons[t["reason"]] += 1
    return {
        "label": params.label or params.signal,
        "signal": params.signal,
        "target_pct": params.target_pct,
        "stop_pct": params.stop_pct,
        "max_hold_hours": params.max_hold_hours,
        "trades": len(trades),
        "pools": len(by_pool),
        "mean_net_pct": round(mean, 3),
        "ci_low": round(lo, 3),
        "ci_high": round(hi, 3),
        "median_net_pct": round(statistics.median(nets), 3),
        "win_rate_pct": round(sum(1 for x in nets if x > 0) / len(nets) * 100, 1),
        "best_pct": round(nets[-1], 2),
        "worst_pct": round(nets[0], 2),
        "p10_pct": round(nets[max(0, int(len(nets) * 0.1) - 1)], 2),
        "mean_cost_pct": round(statistics.fmean([t["cost_pct"] for t in trades]), 3),
        "mean_hold_hours": round(statistics.fmean([t["hold_hours"] for t in trades]), 2),
        "exit_reasons": dict(reasons),
        "hold_mean_net_pct": round(hold_mean, 3),
        "hold_ci_low": round(hold_lo, 3),
        "hold_ci_high": round(hold_hi, 3),
        "edge_vs_hold": round(mean - hold_mean, 3),
    }


def default_variants() -> list[SwapParams]:
    return [
        SwapParams(signal="always", label="tanpa sinyal (kontrol)"),
        SwapParams(signal="breakout", label="breakout 24j"),
        SwapParams(signal="breakout", target_pct=5.0, stop_pct=-5.0, label="breakout +5/-5"),
        SwapParams(signal="breakout", target_pct=20.0, stop_pct=-10.0, label="breakout +20/-10"),
        SwapParams(signal="breakout", max_hold_hours=24.0, label="breakout tahan 24j"),
        SwapParams(signal="momentum_1h", label="naik >5% dalam 1 jam"),
        SwapParams(signal="trend", label="tren naik + ADX>=25"),
        SwapParams(signal="dip", label="setelah dump >10%"),
        SwapParams(signal="squeeze_break", label="squeeze + breakout"),
    ]


async def run(hours: float, save: bool = False) -> list[dict[str, Any]]:
    db = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=2, **config.DB_CONNECT_KWARGS)
    try:
        data = await load_candle_data(db, hours)
        rows = [summarize(simulate(data, p), p) for p in default_variants()]
        if save:
            async with db.acquire() as conn:
                await conn.execute(
                    "insert into momentum_runs (ts, hours, results) values (now(), $1, $2::jsonb)",
                    hours, json.dumps(rows),
                )
    finally:
        await db.close()
    return rows


def print_report(rows: list[dict[str, Any]]) -> None:
    print(f"{'varian':<26}{'trade':>7}{'pool':>6}{'mean%':>9}{'95% CI':>20}{'win%':>7}"
          f"{'biaya%':>8}{'tahan saja%':>13}{'selisih':>9}")
    for r in rows:
        if not r.get("trades"):
            print(f"{r['label']:<26}{0:>7}   tidak ada trade")
            continue
        ci = "[{:+.2f},{:+.2f}]".format(r["ci_low"], r["ci_high"])
        print(f"{r['label']:<26}{r['trades']:>7}{r['pools']:>6}{r['mean_net_pct']:>9.3f}"
              f"{ci:>20}{r['win_rate_pct']:>7.1f}"
              f"{r['mean_cost_pct']:>8.3f}{r['hold_mean_net_pct']:>13.3f}{r['edge_vs_hold']:>9.3f}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Backtest a momentum swap bot on recorded candles")
    ap.add_argument("--hours", type=float, default=720)
    ap.add_argument("--save", action="store_true", help="store the run so the dashboard page can show it")
    args = ap.parse_args()
    print_report(asyncio.run(run(args.hours, save=args.save)))


if __name__ == "__main__":
    main()
