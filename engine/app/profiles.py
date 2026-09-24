"""Risk profiles for paper trading and the backtest.

The profiles trade the same live plans side by side, each with its own virtual equity, so their gains, losses
and drawdowns can be compared on identical market conditions. The engine builds one un-gated plan per pool; a
profile picks which tiers it trades, how strictly fees must cover costs, how big it sizes, how tight its stop is
and how long it holds at least.

Compare them on history with:  uv run python -m app.profiles --hours 720 (quote and USD returns, per-window
stability and walk-forward across profiles)
"""

import argparse
import asyncio
from dataclasses import dataclass, replace

from . import config
from .costs import CostModel
from .paper import PaperConfig
from .recommend import PlanParams

HOUR_MS = 3_600_000


@dataclass(frozen=True)
class RiskProfile:
    key: str
    label: str
    description: str
    tiers: tuple[str, ...]
    max_open_per_tier: int
    size_mult: float
    min_fee_cost_ratio: float
    fee_gate_hours: float
    min_hold_hours: float
    stop_loss_mult: float
    max_drawdown_pct: float | None
    max_atr_pct: float | None = None  # only enter pools calmer than this 30m ATR
    plan_variant: str = "base"  # "single" trades the quote-only version of the plan
    min_reversal_rate: float | None = None  # only pools whose price keeps turning back


PROFILES: tuple[RiskProfile, ...] = (
    RiskProfile(
        key="konservatif",
        label="Konservatif",
        description="Tier rendah dan menengah, fee harus 3x biaya, stop-loss ketat, berhenti di drawdown 5%",
        tiers=("low", "medium"),
        max_open_per_tier=3,
        size_mult=1.0,
        min_fee_cost_ratio=3.0,
        fee_gate_hours=1.0,
        min_hold_hours=2.0,
        stop_loss_mult=0.6,
        max_drawdown_pct=5.0,
    ),
    RiskProfile(
        key="moderat",
        label="Moderat",
        description="Semua tier, fee harus 2x biaya dalam 1 jam, aturan default engine",
        tiers=config.PAPER_TIERS,
        max_open_per_tier=config.PAPER_MAX_OPEN_PER_TIER,
        size_mult=1.0,
        min_fee_cost_ratio=config.MIN_FEE_COST_RATIO,
        fee_gate_hours=config.FEE_GATE_HOURS,
        min_hold_hours=config.MIN_HOLD_HOURS,
        stop_loss_mult=1.0,
        max_drawdown_pct=config.PAPER_MAX_DRAWDOWN_PCT or None,
    ),
    RiskProfile(
        key="tenang",
        label="Tenang",
        description="Aturan Moderat plus hanya pool dengan ATR 30m <=2%: fee tetap, pergerakan harga minim",
        tiers=("low", "medium", "high"),
        max_open_per_tier=5,
        size_mult=1.0,
        min_fee_cost_ratio=config.MIN_FEE_COST_RATIO,
        fee_gate_hours=config.FEE_GATE_HOURS,
        min_hold_hours=config.MIN_HOLD_HOURS,
        stop_loss_mult=1.0,
        max_drawdown_pct=10.0,
        # Forward test of the one rule that beat the defaults over 30 days of candles (+1.04%/trade vs -0.57%,
        # IL -0.13% vs -1.74%). Picked after comparing 15 variants, and never testable out-of-sample there
        # (never 30 training trades in a fold), so paper trading decides it on fresh data.
        max_atr_pct=2.0,
    ),
    RiskProfile(
        key="satu_sisi",
        label="Satu Sisi",
        description="Hanya token quote di bawah harga, pool ATR 30m <=2%: range sempit, tanpa swap saat masuk",
        tiers=("low", "medium", "high"),
        max_open_per_tier=5,
        size_mult=1.0,
        min_fee_cost_ratio=config.MIN_FEE_COST_RATIO,
        fee_gate_hours=config.FEE_GATE_HOURS,
        min_hold_hours=config.MIN_HOLD_HOURS,
        stop_loss_mult=1.0,
        max_drawdown_pct=10.0,
        # Best variant on 30 days of candles: +0.51%/trade [+0.30, +0.72] over 223 trades vs -0.61% for the
        # defaults, with IL -0.24% and costs 0.19%. Chosen on that same data, so paper decides it on fresh data.
        max_atr_pct=2.0,
        plan_variant="single",
    ),
    RiskProfile(
        key="satu_sisi_volatil",
        label="Satu Sisi Volatil",
        description="Seperti Satu Sisi tapi tanpa batas ATR: menguji apakah saringan volatilitas itu yang bekerja",
        tiers=("low", "medium", "high"),
        max_open_per_tier=5,
        size_mult=1.0,
        min_fee_cost_ratio=config.MIN_FEE_COST_RATIO,
        fee_gate_hours=config.FEE_GATE_HOURS,
        min_hold_hours=config.MIN_HOLD_HOURS,
        stop_loss_mult=1.0,
        max_drawdown_pct=10.0,
        # "Satu Sisi" is the only profile in profit on paper (+$33.94 over 25 positions, +6.8%), but it combines
        # two rules: quote-only entry and ATR <= 2%. This one drops the ATR cap, so paper says which half works.
        plan_variant="single",
    ),
    RiskProfile(
        key="satu_sisi_sering",
        label="Satu Sisi Sering",
        description="Seperti Satu Sisi tapi fee cukup 1x biaya: lebih sering masuk, untuk melihat apakah gerbang fee terlalu ketat",
        tiers=("low", "medium", "high"),
        max_open_per_tier=5,
        size_mult=1.0,
        min_fee_cost_ratio=1.0,
        fee_gate_hours=config.FEE_GATE_HOURS,
        min_hold_hours=config.MIN_HOLD_HOURS,
        stop_loss_mult=1.0,
        max_drawdown_pct=10.0,
        # The other half of the same question: "Satu Sisi" only took 25 positions in nine days, too few to judge
        # quickly. Halving the fee gate should roughly double the entries at the same entry shape.
        max_atr_pct=2.0,
        plan_variant="single",
    ),
    RiskProfile(
        key="bolak_balik",
        label="Bolak-balik",
        description="Aturan Moderat plus hanya pool yang harganya sering berbalik arah (>= 0.5 dalam 24 jam): menghindari pool yang sedang tren",
        tiers=("low", "medium", "high"),
        max_open_per_tier=5,
        size_mult=1.0,
        min_fee_cost_ratio=config.MIN_FEE_COST_RATIO,
        fee_gate_hours=config.FEE_GATE_HOURS,
        min_hold_hours=config.MIN_HOLD_HOURS,
        stop_loss_mult=1.0,
        max_drawdown_pct=10.0,
        # On 30 days of candles, results rose with the reversal rate at entry: < 0.40 -3.35%/trade
        # [-6.85, -0.80], 0.40-0.50 -0.27%, 0.50-0.60 +0.10%, >= 0.60 +0.86% [+0.42, +1.33], IL shrinking from
        # -4.4% to -0.1% while fees held steady. 0.5 rather than 0.6: about four times the entries, so paper can
        # reach a verdict in weeks, and it already excludes the trending pools that lost. Only 12% of these
        # entries overlap "tenang" (ATR <= 2%), so this is a different test, not a copy. Cut points were chosen on
        # the same data they were scored on; paper decides.
        min_reversal_rate=0.5,
    ),
    RiskProfile(
        key="tinggi_tenang",
        label="Tinggi Tenang",
        description="Hanya tier tinggi dengan ATR 30m <=2%: menguji bahwa volatilitas, bukan label risiko, yang menentukan rugi",
        tiers=("high",),
        max_open_per_tier=5,
        size_mult=1.0,
        min_fee_cost_ratio=config.MIN_FEE_COST_RATIO,
        fee_gate_hours=config.FEE_GATE_HOURS,
        min_hold_hours=config.MIN_HOLD_HOURS,
        stop_loss_mult=1.0,
        max_drawdown_pct=10.0,
        # Breaking the 30-day backtest down by tier and by ATR showed the high tier is not what loses money: high
        # tier with ATR <2% returned +0.93%/trade over 29 trades (win 76%), while the same tier at ATR 2-5% and
        # 5-10% returned -1.06% and -1.31%. Fees barely move across those buckets (1.26-1.32%); IL does
        # (-0.14% -> -2.01%). Replaces "agresif", which lost on both history and paper for exactly this reason.
        # Chosen on the same candles as the other ATR profiles, so paper trading decides it on fresh data.
        max_atr_pct=2.0,
    ),
    RiskProfile(
        key="agresif",
        label="Agresif",
        description="Tier menengah dan tinggi, ukuran 1,5x, fee cukup 1x biaya dalam 2 jam, stop-loss longgar",
        tiers=("medium", "high"),
        max_open_per_tier=8,
        size_mult=1.5,
        min_fee_cost_ratio=1.0,
        fee_gate_hours=2.0,
        min_hold_hours=1.0,
        stop_loss_mult=1.5,
        max_drawdown_pct=20.0,
    ),
)
PROFILE_BY_KEY = {p.key: p for p in PROFILES}


def paper_config(profile: RiskProfile) -> PaperConfig:
    return PaperConfig(
        enabled=config.PAPER_ENABLED,
        start_equity_usd=config.PAPER_START_EQUITY_USD,
        max_open_per_tier=profile.max_open_per_tier,
        tiers=profile.tiers,
        cooldown_hours=config.PAPER_COOLDOWN_HOURS,
        costs=CostModel(
            enabled=config.PAPER_COSTS_ENABLED,
            tx_cost_sol=config.PAPER_TX_COST_SOL,
            impact_multiplier=config.PAPER_IMPACT_MULTIPLIER,
            new_bin_array_share=config.PAPER_NEW_BIN_ARRAY_SHARE,
            exit_swap_share=config.PAPER_EXIT_SWAP_SHARE,
        ),
        min_position_usd=config.PAPER_MIN_POSITION_USD,
        max_drawdown_pct=profile.max_drawdown_pct,
        profile=profile.key,
        label=profile.label,
        description=profile.description,
        size_mult=profile.size_mult,
        min_fee_cost_ratio=profile.min_fee_cost_ratio,
        fee_gate_hours=profile.fee_gate_hours,
        min_hold_hours=profile.min_hold_hours,
        stop_loss_mult=profile.stop_loss_mult,
        position_floor_usd=config.PAPER_POSITION_FLOOR_USD,
        max_round_trip_cost_pct=config.MAX_ROUND_TRIP_COST_PCT,
        max_stop_loss_pct=config.MAX_STOP_LOSS_PCT,
        max_atr_pct=profile.max_atr_pct,
        plan_variant=profile.plan_variant,
        min_reversal_rate=profile.min_reversal_rate,
    )


def plan_params(profile: RiskProfile, base: PlanParams) -> PlanParams:
    """Backtest parameters for a profile.

    The tier filter is passed through as `allowed_tiers`, so a profile that only trades one tier backtests as
    that profile and not as its unrestricted twin. Open-position caps and the drawdown pause are still not
    simulated, so a backtest counts more entries than paper trading would take.
    """
    return replace(
        base,
        max_position_pct=base.max_position_pct * profile.size_mult,
        allowed_tiers=profile.tiers or None,
        min_fee_cost_ratio=profile.min_fee_cost_ratio,
        fee_gate_hours=profile.fee_gate_hours,
        min_hold_hours=profile.min_hold_hours,
        stop_loss_mult=profile.stop_loss_mult,
        max_atr_pct=profile.max_atr_pct,
        min_reversal_rate=profile.min_reversal_rate,
        force_side="quote" if profile.plan_variant == "single" else None,
        max_round_trip_cost_pct=config.MAX_ROUND_TRIP_COST_PCT,
        max_stop_loss_pct=config.MAX_STOP_LOSS_PCT,
    )


def _usd_view(trades: list[dict]) -> list[dict]:
    """Trades with return_pct replaced by the USD return (trades without a USD value are dropped)."""
    return [dict(t, return_pct=t["return_usd_pct"]) for t in trades if t.get("return_usd_pct") is not None]


async def _compare(hours: float, every: float, window_days: float, train_days: float, test_days: float) -> None:
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    import asyncpg

    from .backtest import default_params, load_candle_data, simulate_candle_trades, summarize
    from .validation import bootstrap_mean_ci, walk_forward

    db = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=2, **config.DB_CONNECT_KWARGS)
    try:
        data = await load_candle_data(db, hours)
    finally:
        await db.close()
    base = default_params()
    sol_ts = data.sol_usd[0]
    print(f"Backtest {hours:g}h ({len(data.history.candles)} pools), entry every {every:g} min, costs included")
    print(f"SOL/USD series: {len(sol_ts)} candles" + ("" if sol_ts else " (none: USD returns unavailable)"))

    def ci_text(trades: list[dict]) -> str:
        if not trades:
            return "-"
        ci = bootstrap_mean_ci(trades)
        return f"{ci['mean']:+.2f}% [{ci['low']:+.2f}, {ci['high']:+.2f}]"

    trades_by_profile: dict[str, list[dict]] = {}
    print(f"\n{'profile':12} {'trades':>6} {'win%':>6} {'mean quote (95% CI)':>28} {'mean USD (95% CI)':>28} {'fee%':>6} {'IL%':>6} {'cost%':>6} {'worst%':>7}")
    for profile in PROFILES:
        params = plan_params(profile, base)
        data.market_cache.clear()
        trades, _ = simulate_candle_trades(data, every, params)
        trades = [t for t in trades if t["tier"] in profile.tiers]
        trades_by_profile[profile.label] = trades
        s = summarize(trades)
        if not trades:
            print(f"{profile.label:12} {0:>6}")
            continue
        print(f"{profile.label:12} {s['trades']:>6} {s['win_rate_pct']:>6} {ci_text(trades):>28} {ci_text(_usd_view(trades)):>28}"
              f" {s['mean_fee_pct']:>6} {s['mean_il_vs_hodl_pct']:>6} {s.get('mean_cost_pct', 0):>6} {s['worst_return_pct']:>7}")

    start_ms, end_ms = data.window_start_ms, data.loaded_at_ms
    tz = ZoneInfo(config.TIMEZONE)

    def wib(ms: int) -> str:
        return datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(tz).strftime("%d %b %H:%M")

    window_ms = int(window_days * 24 * HOUR_MS)
    n_windows = max(1, int((end_ms - start_ms) // window_ms))
    print(f"\nStability: mean net return per {window_days:g}-day window (quote / USD), trades in brackets")
    for label, trades in trades_by_profile.items():
        cells = []
        for w in range(n_windows):
            lo, hi = start_ms + w * window_ms, start_ms + (w + 1) * window_ms
            ts = [t for t in trades if lo <= t["entry_ts"] < hi]
            if not ts:
                cells.append("      -      ")
                continue
            q = sum(t["return_pct"] for t in ts) / len(ts)
            usd = [t["return_usd_pct"] for t in ts if t.get("return_usd_pct") is not None]
            u = f"{sum(usd) / len(usd):+.2f}" if usd else "  - "
            cells.append(f"{q:+.2f}/{u} ({len(ts)})")
        positive = sum(1 for c in cells if c.strip() != "-" and not c.strip().startswith("-"))
        print(f"  {label:12} " + "  ".join(cells) + f"   | positive windows (quote): {positive}/{n_windows}")

    for view, view_trades in (("quote", trades_by_profile), ("USD", {k: _usd_view(v) for k, v in trades_by_profile.items()})):
        wf = walk_forward(view_trades, start_ms, end_ms, int(train_days * 24 * HOUR_MS), int(test_days * 24 * HOUR_MS))
        oos = wf["oos"]
        ci = bootstrap_mean_ci(wf["oos_trades"]) if wf["oos_trades"] else None
        print(f"\nWalk-forward ({view}): train {train_days:g}d -> test {test_days:g}d, profile chosen on train mean")
        for fold in wf["folds"]:
            t = fold["test"]
            print(f"  test from {wib(fold['test_start'])}: chose {fold['chosen']:12} train {fold['train_mean']:+.2f}%"
                  f" -> test {t.get('mean_return_pct', 0):+.2f}% ({t.get('trades', 0)} trades)")
        if ci:
            print(f"  out-of-sample: {oos['trades']} trades, mean {ci['mean']:+.2f}% [{ci['low']:+.2f}, {ci['high']:+.2f}]")
        else:
            print("  out-of-sample: no fold had enough training trades")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare risk profiles on candle history (with costs)")
    parser.add_argument("--hours", type=float, default=168)
    parser.add_argument("--every", type=float, default=60, help="minutes between entry attempts per pool")
    parser.add_argument("--window-days", type=float, default=5, help="stability table window")
    parser.add_argument("--train-days", type=float, default=7, help="walk-forward training window")
    parser.add_argument("--test-days", type=float, default=3, help="walk-forward test window")
    args = parser.parse_args()
    asyncio.run(_compare(args.hours, args.every, args.window_days, args.train_days, args.test_days))


if __name__ == "__main__":
    main()
