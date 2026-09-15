"""Compare LP rule variants on the same candle history (see app.backtest for the approximations).

Usage: uv run python -m app.experiment --hours 168 --every 60
"""

import argparse
import asyncio
from dataclasses import replace
from typing import Any

import asyncpg

from . import config
from .backtest import default_params, evaluate_candles, load_candle_data
from .recommend import PlanParams


def variants(base: PlanParams) -> dict[str, PlanParams]:
    """Each variant changes one thing vs the previous defaults, plus a combined candidate."""
    previous = replace(base, pump_threshold_pct=None, breakout_buffer_pct=0.0, max_atr_pct=None)
    return {
        "previous": previous,
        "pump_filter": replace(previous, pump_threshold_pct=30.0),
        "breakout_buf5": replace(previous, breakout_buffer_pct=5.0),
        "breakout_off": replace(previous, breakout_buffer_pct=None),
        "atr_cap_5": replace(previous, max_atr_pct=5.0),
        "atr_cap_3": replace(previous, max_atr_pct=3.0),
        "curve_atr_3": replace(previous, curve_max_atr_pct=3.0),
        "defaults": base,
        "defaults_atr_2": replace(base, max_atr_pct=2.0),
        "defaults_atr_3": replace(base, max_atr_pct=3.0),
        "defaults_atr_5": replace(base, max_atr_pct=5.0),
    }


TIER_LABELS = {"low": "Risiko rendah", "medium": "Risiko menengah", "high": "Risiko tinggi"}


def _row(name: str, s: dict[str, Any]) -> str:
    if not s.get("trades"):
        return f"{name:<22}{0:>7}"
    return (
        f"{name:<22}{s['trades']:>7}{s['win_rate_pct']:>7.1f}{s['mean_return_pct']:>9.2f}{s['median_return_pct']:>9.2f}"
        f"{s['p10_return_pct']:>9.2f}{s['mean_fee_pct']:>8.2f}{s['mean_il_vs_hodl_pct']:>8.2f}{s['mean_hold_hours']:>6.1f}"
    )


async def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hours", type=float, default=168)
    parser.add_argument("--every", type=float, default=60, help="menit antar entry per pool")
    args = parser.parse_args()

    pool = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=2, **config.DB_CONNECT_KWARGS)
    try:
        data = await load_candle_data(pool, args.hours)
    finally:
        await pool.close()

    header = f"{'varian':<22}{'trade':>7}{'win%':>7}{'mean%':>9}{'median%':>9}{'p10%':>9}{'fee%':>8}{'IL%':>8}{'jam':>6}"
    results = {name: evaluate_candles(data, args.every, params) for name, params in variants(default_params()).items()}

    print(f"Eksperimen candle {args.hours}h, entry tiap {args.every} menit, {len(data.history.candles)} pool\n")
    print("Semua trade")
    print(header)
    for name, report in results.items():
        print(_row(name, report["overall"]))
    print()
    for tier, label in TIER_LABELS.items():
        print(label)
        print(header)
        for name, report in results.items():
            print(_row(name, report["by_tier"].get(tier, {})))
        print()

    for name in ("previous", "defaults"):
        print(f"{name}: per strategi")
        print(header)
        for strategy, stats in results[name]["by_strategy"].items():
            print(_row(f"  {strategy}", stats))
        print(f"  alasan exit: {results[name]['overall'].get('exit_reasons')}")
        print(f"  entry dilewati: {results[name]['skipped_entries']}\n")


if __name__ == "__main__":
    asyncio.run(_main())
