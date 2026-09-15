import math

from app.backtest import LpPosition, simulate
from app.costs import CostModel, round_trip_cost_pct
from app.paper import Position, accrue, exit_reason
from app.recommend import PlanParams, apply_cost_gate

HOUR = 3_600_000
PARAMS = PlanParams(portfolio_usd=1000, max_position_pct=5, hold_hours=4)  # min hold 2h, ratio 2x
POOL = {"price": 1.0, "tvl": 100_000.0, "fees": {"1h": 100.0}, "base_fee_pct": 1.0, "dynamic_fee_pct": 0.0,
        "token_y": {"price_usd": 1.0}}
RULES = {"stop_loss_pct": 10.0, "out_of_range_minutes": 20.0, "fee_decay_ratio": 0.25, "max_hold_hours": 8.0,
         "breakout_below_pct": -3.0, "breakout_above_pct": 3.0, "min_hold_hours": 2.0}


def _pos(**overrides) -> Position:
    kwargs = dict(
        id=1, address="POOL", name="MEME-SOL", base_mint="MEME", tier="medium", strategy="spot", bin_step=100,
        entry_ts=0, entry_price=1.0, range_low_pct=-10.0, range_high_pct=10.0, capital_usd=50.0, capital_y=50.0,
        entry_fee_rate=0.01, exit_rules=dict(RULES), value_y=50.0, fees_y=0.0, last_ts=0, last_price=1.0,
        last_rate=0.01,
    )
    kwargs.update(overrides)
    return Position(**kwargs)


def test_cost_gate_blocks_entries_whose_fees_do_not_cover_costs():
    plan = {"action": "enter", "tier": "low", "regime": "ranging"}
    # Default gate counts 1h of fees: 12%/day -> 0.5%, below 2x a 0.5% cost.
    gated = apply_cost_gate(plan, 0.5, 12.0, PARAMS)
    assert gated["action"] == "wait" and gated["gated_tier"] == "low" and gated["round_trip_cost_pct"] == 0.5
    # 48%/day -> 2% in 1h, above 2x 0.5%.
    kept = apply_cost_gate(plan, 0.5, 48.0, PARAMS)
    assert kept["action"] == "enter" and math.isclose(kept["fee_over_min_hold_pct"], 2.0)


def test_round_trip_cost_is_positive_and_excludes_refundable_rent():
    lp = LpPosition.build(1.0, 100, -10.0, 10.0, 50.0)
    model = CostModel()
    cost = round_trip_cost_pct(lp, 1, POOL, 1.0, 150.0, model)
    assert 0 < cost < model.position_rent_sol * 150 / 50 * 100  # rent (~17% of $50) is not counted
    assert round_trip_cost_pct(lp, 1, POOL, 1.0, 150.0, CostModel(enabled=False)) == 0.0


def test_min_hold_suppresses_breakout_but_not_stop_loss():
    pos = _pos()
    accrue(pos, dict(POOL, price=1.05), HOUR)  # +5%: beyond the +3% breakout, still in range
    assert exit_reason(pos, HOUR) is None
    assert exit_reason(pos, 2 * HOUR) == "breakout"
    crash = _pos()
    accrue(crash, dict(POOL, price=0.5), HOUR)
    assert exit_reason(crash, HOUR) == "stop_loss"


def test_fee_decay_uses_smoothed_rate():
    pos = _pos(exit_rules=dict(RULES, breakout_below_pct=None, breakout_above_pct=None))
    accrue(pos, dict(POOL, fees={"1h": 1_000.0}), 2 * HOUR)  # 1%/h, same as entry
    accrue(pos, dict(POOL, fees={"1h": 0.0}), 2 * HOUR + 60_000)  # one quiet minute
    assert pos.last_rate == 0.0 and pos.rate_avg > 0.0025
    assert exit_reason(pos, 2 * HOUR + 60_000) is None


def test_backtest_return_is_net_of_costs_and_respects_min_hold():
    series = [(i * 30 * 60_000, 1.0 + 0.05 * (i == 1)) for i in range(12)]
    plan = {"range_low_pct": -10.0, "range_high_pct": 10.0, "positions": 1, "exit": dict(RULES)}
    rate = lambda ts: (0.001, 100_000.0)  # noqa: E731
    gross = simulate(series, 0, rate, 50.0, 100, plan)
    net = simulate(series, 0, rate, 50.0, 100, plan, CostModel(), {"base_fee_pct": 1.0}, 150.0)
    assert gross["exit_reason"] != "breakout"  # the +5% spike happened before the 2h minimum hold
    assert net["cost_pct"] > 0 and math.isclose(net["return_pct"], net["gross_return_pct"] - net["cost_pct"])
    assert net["return_pct"] < gross["return_pct"]
