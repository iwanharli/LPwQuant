"""Statistical validation of LP rule variants on candle backtests.

- Cluster bootstrap: trades entered in the same hour move together (a market-wide dump hits every pool),
  so resampling is done over entry hours, not individual trades. Gives 95% CIs for the mean return and for
  the difference between two variants (paired over the same resampled hours).
- Walk-forward: pick the best variant on a training window, measure it on the following unseen test window,
  roll forward, and pool the out-of-sample trades. Training trades whose exit falls after the training
  window are purged so selection never peeks at test-period prices.

Usage: uv run python -m app.validation --hours 168 --train-hours 72 --test-hours 24
"""

import argparse
import asyncio
import math
import random
import statistics
from collections import defaultdict
from typing import Any, Callable, Sequence

import asyncpg

from . import config
from .backtest import default_params, load_candle_data, simulate_candle_trades, summarize

HOUR_MS = 3_600_000
MIN_TRAIN_TRADES = 30
Trade = dict[str, Any]


def _mean(trades: Sequence[Trade]) -> float | None:
    return statistics.fmean(t["return_pct"] for t in trades) if trades else None


def cluster_by_hour(trades: Sequence[Trade]) -> dict[int, list[float]]:
    clusters: defaultdict[int, list[float]] = defaultdict(list)
    for t in trades:
        clusters[t["entry_ts"] // HOUR_MS].append(t["return_pct"])
    return dict(clusters)


def cluster_by_pool(trades: Sequence[Trade]) -> dict[str, list[float]]:
    """Repeated entries into one pool share its fate (paper trading entered ELON-SOL five times and lost all five),
    so they are one observation more than five."""
    clusters: defaultdict[str, list[float]] = defaultdict(list)
    for t in trades:
        clusters[t.get("address") or "?"].append(t["return_pct"])
    return dict(clusters)


def _quantile(sorted_values: Sequence[float], q: float) -> float:
    return sorted_values[min(len(sorted_values) - 1, max(0, math.floor(q * len(sorted_values))))]


def bootstrap_mean_ci(
    trades: Sequence[Trade], n_boot: int = 2000, alpha: float = 0.05, seed: int = 7, by: str = "hour"
) -> dict[str, Any]:
    clusters = list((cluster_by_pool(trades) if by == "pool" else cluster_by_hour(trades)).values())
    mean = _mean(trades)
    if len(clusters) < 2:
        return {"mean": mean, "low": None, "high": None, "clusters": len(clusters)}
    rng = random.Random(seed)
    means = []
    for _ in range(n_boot):
        total = count = 0
        for _ in range(len(clusters)):
            c = rng.choice(clusters)
            total += sum(c)
            count += len(c)
        means.append(total / count)
    means.sort()
    return {
        "mean": mean,
        "low": _quantile(means, alpha / 2),
        "high": _quantile(means, 1 - alpha / 2),
        "clusters": len(clusters),
    }


def conservative_mean_ci(trades: Sequence[Trade], **kwargs: Any) -> dict[str, Any]:
    """The wider of the entry-hour and the pool clustered intervals. Trades in one hour move together (a
    market-wide dump) and so do repeated trades in one pool; each clustering catches one and misses the other, so
    a verdict only counts when it survives both."""
    by_hour = bootstrap_mean_ci(trades, by="hour", **kwargs)
    by_pool = bootstrap_mean_ci(trades, by="pool", **kwargs)
    lows = [c["low"] for c in (by_hour, by_pool) if c["low"] is not None]
    highs = [c["high"] for c in (by_hour, by_pool) if c["high"] is not None]
    return {
        "mean": by_hour["mean"],
        "low": min(lows) if len(lows) == 2 else None,
        "high": max(highs) if len(highs) == 2 else None,
        "hour_clusters": by_hour["clusters"],
        "pool_clusters": by_pool["clusters"],
    }


def bootstrap_diff_ci(
    trades_a: Sequence[Trade], trades_b: Sequence[Trade], n_boot: int = 2000, alpha: float = 0.05, seed: int = 7
) -> dict[str, Any]:
    """mean(a) - mean(b), resampling the same entry hours for both; p_a_better = share of resamples with a > b."""
    ca, cb = cluster_by_hour(trades_a), cluster_by_hour(trades_b)
    hours = sorted(set(ca) | set(cb))
    ma, mb = _mean(trades_a), _mean(trades_b)
    diff = ma - mb if ma is not None and mb is not None else None
    if len(hours) < 2 or diff is None:
        return {"diff": diff, "low": None, "high": None, "p_a_better": None}
    rng = random.Random(seed)
    diffs = []
    for _ in range(n_boot):
        sa = na = sb = nb = 0
        for _ in range(len(hours)):
            h = rng.choice(hours)
            a, b = ca.get(h, ()), cb.get(h, ())
            sa, na = sa + sum(a), na + len(a)
            sb, nb = sb + sum(b), nb + len(b)
        if na and nb:
            diffs.append(sa / na - sb / nb)
    diffs.sort()
    return {
        "diff": diff,
        "low": _quantile(diffs, alpha / 2),
        "high": _quantile(diffs, 1 - alpha / 2),
        "p_a_better": sum(d > 0 for d in diffs) / len(diffs),
    }


def trades_between(trades: Sequence[Trade], start: int, end: int, purge: bool) -> list[Trade]:
    """Trades entered in [start, end); with purge, also require the exit to happen before `end`."""
    return [t for t in trades if start <= t["entry_ts"] < end and (not purge or t["exit_ts"] <= end)]


def mean_objective(trades: Sequence[Trade]) -> float | None:
    return _mean(trades) if len(trades) >= MIN_TRAIN_TRADES else None


def walk_forward(
    trades_by_variant: dict[str, list[Trade]],
    start_ms: int,
    end_ms: int,
    train_ms: int,
    test_ms: int,
    objective: Callable[[Sequence[Trade]], float | None] = mean_objective,
) -> dict[str, Any]:
    folds = []
    oos: list[Trade] = []
    test_start = start_ms + train_ms
    while test_start + test_ms <= end_ms:
        train_start, test_end = test_start - train_ms, test_start + test_ms
        train_scores = {
            name: objective(trades_between(trades, train_start, test_start, purge=True))
            for name, trades in trades_by_variant.items()
        }
        eligible = {k: v for k, v in train_scores.items() if v is not None}
        if eligible:
            chosen = max(eligible, key=eligible.__getitem__)
            test_trades = trades_between(trades_by_variant[chosen], test_start, test_end, purge=False)
            oos.extend(test_trades)
            folds.append({
                "train_start": train_start,
                "test_start": test_start,
                "test_end": test_end,
                "chosen": chosen,
                "train_mean": eligible[chosen],
                "test": summarize(test_trades),
            })
        test_start = test_end
    return {"folds": folds, "oos_trades": oos, "oos": summarize(oos)}


def _fmt(v: float | None, digits: int = 2, signed: bool = True) -> str:
    if v is None:
        return "–"
    return f"{v:+.{digits}f}" if signed else f"{v:.{digits}f}"


async def _main() -> None:
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    from .experiment import variants

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hours", type=float, default=168)
    parser.add_argument("--every", type=float, default=60)
    parser.add_argument("--train-hours", type=float, default=72)
    parser.add_argument("--test-hours", type=float, default=24)
    parser.add_argument("--baseline", default="defaults")
    args = parser.parse_args()

    pool = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=2, **config.DB_CONNECT_KWARGS)
    try:
        data = await load_candle_data(pool, args.hours)
    finally:
        await pool.close()

    trades_by_variant: dict[str, list[Trade]] = {}
    for name, params in variants(default_params()).items():
        trades, _ = simulate_candle_trades(data, args.every, params)
        trades_by_variant[name] = trades
    baseline = trades_by_variant[args.baseline]
    tz = ZoneInfo(config.TIMEZONE)
    day = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(tz).strftime("%m-%d %H:%M")  # noqa: E731

    print(f"Validasi candle {args.hours}h ({len(data.history.candles)} pool), entry tiap {args.every} menit\n")
    print("1) Seluruh periode: rata-rata return per trade, 95% CI (bootstrap per jam entry)")
    print(f"{'varian':<22}{'trade':>7}{'mean%':>9}{'CI low':>9}{'CI high':>9}   vs {args.baseline}: selisih [CI]  P(lebih baik)")
    for name, trades in trades_by_variant.items():
        ci = bootstrap_mean_ci(trades)
        diff = bootstrap_diff_ci(trades, baseline) if name != args.baseline else None
        diff_text = (
            f"{_fmt(diff['diff'])} [{_fmt(diff['low'])}, {_fmt(diff['high'])}]  {_fmt(diff['p_a_better'], 2, False)}"
            if diff else "–"
        )
        print(f"{name:<22}{len(trades):>7}{_fmt(ci['mean']):>9}{_fmt(ci['low']):>9}{_fmt(ci['high']):>9}   {diff_text}")

    print(f"\n1b) Per tier risiko ({args.baseline}): apakah risiko lebih tinggi memberi return lebih tinggi?")
    print(f"{'tier':<22}{'trade':>7}{'mean%':>9}{'CI low':>9}{'CI high':>9}{'p10%':>9}{'fee%':>8}{'IL%':>8}")
    for tier, label in (("low", "Risiko rendah"), ("medium", "Risiko menengah"), ("high", "Risiko tinggi")):
        tier_trades = [t for t in baseline if t.get("tier") == tier]
        ci = bootstrap_mean_ci(tier_trades)
        s = summarize(tier_trades)
        print(f"{label:<22}{len(tier_trades):>7}{_fmt(ci['mean']):>9}{_fmt(ci['low']):>9}{_fmt(ci['high']):>9}"
              f"{_fmt(s.get('p10_return_pct')):>9}{_fmt(s.get('mean_fee_pct'), 2, False):>8}"
              f"{_fmt(s.get('mean_il_vs_hodl_pct')):>8}")

    start_ms = data.window_start_ms
    end_ms = data.loaded_at_ms
    wf = walk_forward(trades_by_variant, start_ms, end_ms, int(args.train_hours * HOUR_MS), int(args.test_hours * HOUR_MS))
    print(f"\n2) Walk-forward: latih {args.train_hours:g} jam, uji {args.test_hours:g} jam berikutnya (WIB)")
    print(f"{'uji mulai':<14}{'dipilih':<22}{'mean latih%':>12}{'trade uji':>10}{'mean uji%':>10}")
    for f in wf["folds"]:
        print(f"{day(f['test_start']):<14}{f['chosen']:<22}{_fmt(f['train_mean']):>12}"
              f"{f['test'].get('trades', 0):>10}{_fmt(f['test'].get('mean_return_pct')):>10}")

    if wf["folds"]:
        oos_ci = bootstrap_mean_ci(wf["oos_trades"])
        base_oos = [t for f in wf["folds"] for t in trades_between(baseline, f["test_start"], f["test_end"], purge=False)]
        base_ci = bootstrap_mean_ci(base_oos)
        diff = bootstrap_diff_ci(wf["oos_trades"], base_oos)
        print(f"\nOut-of-sample (pilihan walk-forward): {len(wf['oos_trades'])} trade, mean {_fmt(oos_ci['mean'])}% "
              f"[{_fmt(oos_ci['low'])}, {_fmt(oos_ci['high'])}], win {wf['oos'].get('win_rate_pct', 0)}%")
        print(f"Out-of-sample ({args.baseline} tetap): {len(base_oos)} trade, mean {_fmt(base_ci['mean'])}% "
              f"[{_fmt(base_ci['low'])}, {_fmt(base_ci['high'])}]")
        print(f"Selisih pilihan − {args.baseline}: {_fmt(diff['diff'])} [{_fmt(diff['low'])}, {_fmt(diff['high'])}], "
              f"P(lebih baik) {_fmt(diff['p_a_better'], 2, False)}")
        verdict = (
            "positif signifikan" if (oos_ci["low"] or -1) > 0
            else "negatif signifikan" if (oos_ci["high"] or 1) < 0
            else "tidak berbeda signifikan dari nol"
        )
        print(f"Kesimpulan: return out-of-sample {verdict}.")
    else:
        print("Data belum cukup untuk satu fold walk-forward.")


if __name__ == "__main__":
    asyncio.run(_main())
