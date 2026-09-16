import math

from app.backtest import LpPosition
from app.scoring import effective_tvl
from app.paper import (
    CostModel,
    PaperConfig,
    Position,
    accrue,
    entries_paused,
    entry_costs,
    exit_cost,
    exit_reason,
    pick_entries,
    sanitize_exit_rules,
    swap_cost_fraction,
)

HOUR = 3_600_000
MINUTE = 60_000
CFG = PaperConfig(enabled=True, start_equity_usd=1000, max_open_per_tier=2, tiers=("low", "medium", "high"),
                  cooldown_hours=6)
RULES = {"stop_loss_pct": 10.0, "out_of_range_minutes": 20.0, "fee_decay_ratio": 0.25, "max_hold_hours": 8.0,
         "breakout_below_pct": None, "breakout_above_pct": None}


def position(**overrides) -> Position:
    kwargs = dict(
        id=1, address="POOL", name="MEME-SOL", base_mint="MEME", tier="medium", strategy="spot", bin_step=100,
        entry_ts=0, entry_price=1.0, range_low_pct=-10.0, range_high_pct=10.0, capital_usd=50.0, capital_y=0.5,
        entry_fee_rate=0.01, exit_rules=dict(RULES), value_y=0.5, fees_y=0.0, last_ts=0, last_price=1.0,
        last_rate=0.01, last_tvl=100_000.0,  # opening a position seeds last_tvl from the pool
    )
    kwargs.update(overrides)
    return Position(**kwargs)


def pool(price: float, fees_1h: float = 1_000.0, tvl: float = 100_000.0) -> dict:
    return {"price": price, "tvl": tvl, "fees": {"1h": fees_1h}}


def test_flat_price_earns_fees_and_stays_open():
    pos = position()
    for minute in range(1, 61):
        accrue(pos, pool(1.0), minute * MINUTE)
    assert pos.fee_pct() > 0.9  # ~1%/h fee rate, slightly diluted
    assert pos.pnl_pct() > 0 and exit_reason(pos, 60 * MINUTE) is None
    assert pos.min_price < 1.0 < pos.max_price


def test_crash_triggers_stop_loss():
    pos = position(range_low_pct=-40.0)
    accrue(pos, pool(0.75), MINUTE)
    assert pos.pnl_pct() <= -10
    assert exit_reason(pos, MINUTE) == "stop_loss"


def test_out_of_range_needs_the_full_window():
    pos = position(exit_rules=dict(RULES, stop_loss_pct=50.0))
    accrue(pos, pool(1.2), MINUTE)  # above the +10% range
    assert pos.out_of_range_since == MINUTE and exit_reason(pos, MINUTE) is None
    accrue(pos, pool(1.2), 25 * MINUTE)
    assert exit_reason(pos, 25 * MINUTE) == "out_of_range"
    accrue(pos, pool(1.0), 26 * MINUTE)
    assert pos.out_of_range_since is None


def test_fee_decay_and_max_hold():
    pos = position()
    accrue(pos, pool(1.0, fees_1h=100.0), 2 * HOUR)  # rate fell from 1%/h to 0.1%/h
    assert exit_reason(pos, 2 * HOUR) is None  # the smoothed rate has not decayed enough yet
    accrue(pos, pool(1.0, fees_1h=100.0), 4 * HOUR)  # still 0.1%/h two hours later
    assert exit_reason(pos, 4 * HOUR) == "fee_decay"
    pos = position(entry_fee_rate=0.0)
    accrue(pos, pool(1.0, fees_1h=0.0), 9 * HOUR)
    assert exit_reason(pos, 9 * HOUR) == "max_hold"


def row(address: str, tier: str, score: float, mint: str | None = None, action: str = "enter") -> dict:
    return {"address": address, "name": f"{address}-SOL", "base_mint": mint or address, "score": score, "price": 1.0,
            "bin_step": 100, "plan": {"action": action, "tier": tier, "size_usd": 30.0}}


def test_pick_entries_caps_per_tier_dedupes_tokens_and_respects_cooldown():
    rows = [
        row("A", "high", 90), row("B", "high", 80), row("C", "high", 70),  # only 2 high allowed
        row("D", "low", 60, mint="SAME"), row("E", "low", 55, mint="SAME"),  # same token: one only
        row("F", "medium", 50), row("G", "medium", 40, action="avoid"),
        row("H", "medium", 45),
    ]
    picked = pick_entries(rows, [], {"H": 10 * HOUR - HOUR}, CFG, 10 * HOUR)  # H closed an hour ago
    assert [r["address"] for r in picked] == ["A", "B", "D", "F"]

    already_open = [position(address="A", tier="high", base_mint="A")]
    picked = pick_entries(rows, already_open, {}, CFG, 10 * HOUR)
    assert [r["address"] for r in picked if r["plan"]["tier"] == "high"] == ["B"]


def test_min_position_size_and_drawdown_pause():
    small = dict(row("SMALL", "high", 99), plan={"action": "enter", "tier": "high", "size_usd": 10.0})
    picked = pick_entries([small, row("OK", "high", 50)], [], {}, CFG, 10 * HOUR)
    assert [r["address"] for r in picked] == ["OK"]  # $10 plan is below the $25 minimum

    assert entries_paused(900.0, 1000.0, 10.0) is True  # exactly 10% below peak
    assert entries_paused(950.0, 1000.0, 10.0) is False
    assert entries_paused(500.0, 1000.0, None) is False


def test_cooldown_applies_to_the_token_across_pools():
    # USELESS-SOL closed a minute ago; USELESS-USDC (same token, other pool) must wait too.
    rows = [row("USELESS-USDC", "low", 90, mint="USELESS"), row("OTHER", "low", 80)]
    picked = pick_entries(rows, [], {}, CFG, 10 * HOUR, {"USELESS": 10 * HOUR - MINUTE})
    assert [r["address"] for r in picked] == ["OTHER"]
    later = pick_entries(rows, [], {}, CFG, 17 * HOUR, {"USELESS": 10 * HOUR - MINUTE})
    assert [r["address"] for r in later] == ["USELESS-USDC", "OTHER"]


def test_base_value_splits_position_value():
    lp = LpPosition.build(p0=2.0, bin_step=50, range_low_pct=-15.0, range_high_pct=10.0, capital=1000.0)
    assert math.isclose(lp.base_value(2.0), lp.v * (lp.b + 0.5))  # bins above + half the active bin
    assert lp.base_value(100.0) == 0.0  # far above range: all sold to quote
    assert math.isclose(lp.base_value(0.5), lp.value(0.5))  # far below range: all base


COST_POOL = {"price": 1.0, "tvl": 100_000.0, "fees": {"1h": 0.0}, "base_fee_pct": 1.0, "dynamic_fee_pct": 0.5,
             "token_y": {"price_usd": 150.0}}


def test_swap_cost_includes_fee_and_capped_impact():
    model = CostModel()
    assert math.isclose(swap_cost_fraction(COST_POOL, 1_000.0, model), 0.015 + 0.01)
    assert math.isclose(swap_cost_fraction(COST_POOL, 1e9, model), 0.015 + 0.05)


def test_entry_costs_depend_on_strategy_side():
    model = CostModel(tx_cost_sol=0.001)
    two_sided = LpPosition.build(1.0, 100, -10.0, 10.0, 1.0)  # 1 SOL of capital
    quote_only = LpPosition.build(1.0, 100, -10.0, 0.0, 1.0)
    cost_two, rent = entry_costs(two_sided, 1, COST_POOL, 150.0, 1.0, model)
    cost_bid_ask, _ = entry_costs(quote_only, 1, COST_POOL, 150.0, 1.0, model)
    assert cost_bid_ask < cost_two  # bid-ask barely swaps
    assert math.isclose(rent, model.position_rent_sol)
    assert cost_two > 2 * 0.001  # at least the two open txs
    assert entry_costs(two_sided, 1, COST_POOL, 150.0, 1.0, CostModel(enabled=False)) == (0.0, 0.0)


def test_costs_reduce_net_pnl_but_not_gross():
    model = CostModel()
    pos = position(capital_y=1.0, value_y=1.0, positions=2)
    pos.cost_entry_y, pos.rent_sol = entry_costs(pos.lp, 2, COST_POOL, 150.0, 1.0, model)
    accrue(pos, dict(COST_POOL), MINUTE, model, sol_usd=150.0)
    assert pos.cost_exit_y > 0
    assert math.isclose(pos.gross_pnl_pct() - pos.pnl_pct(), pos.cost_pct())
    assert pos.pnl_pct() < pos.gross_pnl_pct()
    # Exiting after price ran far above range: nothing to swap back, only close txs.
    assert math.isclose(exit_cost(pos.lp, 10.0, 2, COST_POOL, 150.0, 1.0, model), 2 * 2 * model.tx_cost_sol)


def test_stale_tight_breakout_levels_are_dropped_on_load():
    stored = dict(RULES, breakout_below_pct=-4.7, breakout_above_pct=0.4)
    # A stop-loss wider than today's cap is tightened for positions opened under the old rules.
    assert sanitize_exit_rules(dict(RULES, stop_loss_pct=30.0), atr_pct=1.0, max_stop_loss_pct=10.0)["stop_loss_pct"] == 10.0
    assert sanitize_exit_rules(dict(RULES, stop_loss_pct=8.0), atr_pct=1.0, max_stop_loss_pct=10.0)["stop_loss_pct"] == 8.0
    # Rules stored before the minimum hold existed get the default.
    assert sanitize_exit_rules(stored, atr_pct=1.0) == dict(stored, breakout_above_pct=None, min_hold_hours=2.0)
    # With a 5% ATR, a -4.7% level is also too close.
    assert sanitize_exit_rules(stored, atr_pct=5.0)["breakout_below_pct"] is None

    pos = position(exit_rules=sanitize_exit_rules(stored, 1.0), range_low_pct=-8.0, range_high_pct=9.0)
    accrue(pos, pool(1.005), MINUTE)  # +0.5%: above the stale 0.4% level
    assert exit_reason(pos, MINUTE) is None


def test_accrue_scales_fees_by_range_realization():
    base = dict(COST_POOL, fees={"1h": 1_000.0})
    narrow = position(capital_y=1.0, value_y=1.0)  # -10%/+10% at bin step 100: 22 bins
    wide = position(capital_y=1.0, value_y=1.0, range_low_pct=-60.0, range_high_pct=60.0)  # >70 bins
    accrue(narrow, base, HOUR)
    accrue(wide, base, HOUR)
    assert narrow.lp.a + narrow.lp.b + 1 <= 70 < wide.lp.a + wide.lp.b + 1
    tvl_share = 1_000.0 / 100_000.0 * 100_000.0 / (100_000.0 + 50.0)  # pool fee rate x TVL share of capital_usd
    assert math.isclose(narrow.fees_y, 1.0 * tvl_share)
    assert math.isclose(wide.fees_y, 0.65 * tvl_share)

def test_entry_costs_charge_known_new_bin_arrays():
    model = CostModel()
    lp = LpPosition.build(1.0, 100, -10.0, 10.0, 1.0)
    base_cost, _ = entry_costs(lp, 1, COST_POOL, 150.0, 1.0, model)
    with_arrays, _ = entry_costs(lp, 1, COST_POOL, 150.0, 1.0, model, new_bin_arrays=2)
    assert math.isclose(with_arrays - base_cost, 2 * model.bin_array_rent_sol)


def test_effective_tvl_floors_drained_pools():
    # CHIP-USDC reported $0.000377 of TVL while 24h volume was $310k: fees/TVL came out at 298,507,864%/day.
    drained = {"tvl": 0.000377, "volume": {"24h": 310_213.0}}
    assert effective_tvl(drained) == 310_213.0 / 20.0
    healthy = {"tvl": 100_000.0, "volume": {"24h": 50_000.0}}
    assert effective_tvl(healthy) == 100_000.0  # a real TVL is never lowered
    assert effective_tvl({"tvl": 500.0}) == 500.0  # no volume reported: nothing to floor with


def test_fees_use_the_tvl_the_rate_was_measured_against():
    # 2026-09-16 19:00:13 UTC the pool read $0.000372 of TVL, at 19:01:13 it read $199.62. Taking the rate from
    # the collapsed reading and the TVL share from the restored one booked $3.4M of fees on a $100 position in
    # one cycle, and carried four paper profiles to $3.4M of virtual equity.
    volume = {"24h": 310_213.0}
    collapsed = {"price": 1.0, "tvl": 0.000372, "fees": {"1h": 47.0}, "volume": volume}
    restored = {"price": 1.0, "tvl": 199.62, "fees": {"1h": 47.0}, "volume": volume}
    pos = position(capital_usd=100.0, capital_y=100.0, value_y=100.0, last_tvl=0.0)
    accrue(pos, collapsed, MINUTE)
    accrue(pos, restored, 2 * MINUTE)
    assert pos.fee_pct() < 1.0  # was 3,387,371% before the fix


def test_restored_position_seeds_tvl_before_accruing():
    # last_tvl is not persisted, so a position loaded from the database starts at 0. It must seed, not pair the
    # stored rate with today's TVL, and it must not stop earning fees for good either.
    pos = position(last_tvl=0.0)
    accrue(pos, pool(1.0), MINUTE)
    assert pos.fees_y == 0.0 and pos.last_tvl == 100_000.0
    accrue(pos, pool(1.0), 2 * MINUTE)
    assert pos.fees_y > 0
