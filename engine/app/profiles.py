"""Risk profiles for paper trading and the backtest.

Three profiles trade the same live plans side by side, each with its own virtual equity, so their gains, losses
and drawdowns can be compared on identical market conditions. The engine builds one un-gated plan per pool; a
profile picks which tiers it trades, how strictly fees must cover costs, how big it sizes, how tight its stop is
and how long it holds at least.

Compare them on history with:  uv run python -m app.profiles --hours 168
"""

import argparse
import asyncio
from dataclasses import dataclass, replace

from . import config
from .costs import CostModel
from .paper import PaperConfig
from .recommend import PlanParams


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
    )


def plan_params(profile: RiskProfile, base: PlanParams) -> PlanParams:
    """Backtest parameters for a profile (tier filter is applied to the trades; open-position caps and the
    drawdown pause are not simulated)."""
    return replace(
        base,
        max_position_pct=base.max_position_pct * profile.size_mult,
        min_fee_cost_ratio=profile.min_fee_cost_ratio,
        fee_gate_hours=profile.fee_gate_hours,
        min_hold_hours=profile.min_hold_hours,
        stop_loss_mult=profile.stop_loss_mult,
    )


async def _compare(hours: float, every: float) -> None:
    import asyncpg

    from .backtest import default_params, load_candle_data, simulate_candle_trades, summarize
    from .validation import bootstrap_mean_ci

    db = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=2, **config.DB_CONNECT_KWARGS)
    try:
        data = await load_candle_data(db, hours)
    finally:
        await db.close()
    base = default_params()
    print(f"Backtest {hours:g}h, entry every {every:g} min, costs included\n")
    print(f"{'profil':12} {'trades':>6} {'win%':>6} {'mean%':>7} {'95% CI':>18} {'fee%':>6} {'IL%':>6} {'biaya%':>6} "
          f"{'p10%':>7} {'worst%':>7} {'USD/trade':>9}")
    for profile in PROFILES:
        params = plan_params(profile, base)
        data.market_cache.clear()
        trades, _ = simulate_candle_trades(data, every, params)
        trades = [t for t in trades if t["tier"] in profile.tiers]
        s = summarize(trades)
        if not trades:
            print(f"{profile.label:12} {0:>6}")
            continue
        ci = bootstrap_mean_ci(trades)
        capital = params.portfolio_usd * params.max_position_pct / 100
        print(f"{profile.label:12} {s['trades']:>6} {s['win_rate_pct']:>6} {s['mean_return_pct']:>7} "
              f"{f'[{ci['low']:.2f}, {ci['high']:.2f}]':>18} {s['mean_fee_pct']:>6} {s['mean_il_vs_hodl_pct']:>6} "
              f"{s.get('mean_cost_pct', 0):>6} {s['p10_return_pct']:>7} {s['worst_return_pct']:>7} "
              f"{capital * s['mean_return_pct'] / 100:>9.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare risk profiles on candle history (with costs)")
    parser.add_argument("--hours", type=float, default=168)
    parser.add_argument("--every", type=float, default=60, help="minutes between entry attempts per pool")
    args = parser.parse_args()
    asyncio.run(_compare(args.hours, args.every))


if __name__ == "__main__":
    main()
