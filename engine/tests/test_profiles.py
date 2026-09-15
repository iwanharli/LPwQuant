import math

from app.paper import pick_entries, profile_plan
from app.profiles import PROFILE_BY_KEY, PROFILES, paper_config, plan_params
from app.recommend import PlanParams, cost_gate_ok


def _cfg(key):
    """Profile config without the paper position floor, so sizing and gating rules are tested on their own."""
    from dataclasses import replace

    return replace(paper_config(PROFILE_BY_KEY[key]), position_floor_usd=0.0)

BASE_EXIT = {"stop_loss_pct": 10.0, "out_of_range_minutes": 20.0, "fee_decay_ratio": 0.25, "max_hold_hours": 8.0,
             "breakout_below_pct": None, "breakout_above_pct": None, "min_hold_hours": 2.0}


def row(tier="medium", cost=0.5, fee_day=12.0, size=40.0, tvl=100_000.0, address="POOL", mint="MEME", score=50.0):
    base = {"action": "enter", "tier": tier, "strategy": "spot", "size_usd": size, "exit": dict(BASE_EXIT),
            "round_trip_cost_pct": cost, "range_low_pct": -10.0, "range_high_pct": 10.0}
    return {"address": address, "base_mint": mint, "score": score, "price": 1.0, "tvl": tvl,
            "fee_for_position_pct_day": fee_day, "plan_base": base,
            "plan": {"action": "wait", "reason": "gated by default profile"}}


def test_three_profiles_with_distinct_rules():
    assert [p.key for p in PROFILES] == ["konservatif", "moderat", "agresif"]
    cons, agg = PROFILE_BY_KEY["konservatif"], PROFILE_BY_KEY["agresif"]
    assert cons.min_fee_cost_ratio > agg.min_fee_cost_ratio and cons.stop_loss_mult < agg.stop_loss_mult
    assert "high" not in cons.tiers and "low" not in agg.tiers
    assert paper_config(cons).profile == "konservatif" and paper_config(agg).size_mult == 1.5


def test_cost_gate_ok():
    assert cost_gate_ok(0.0, 0.0, 1.0, 3.0)
    assert cost_gate_ok(0.5, 24.0, 1.0, 2.0)  # 1% in 1h >= 2 x 0.5%
    assert not cost_gate_ok(0.5, 12.0, 1.0, 2.0)  # 0.5% < 1%


def test_each_profile_gates_the_same_plan_differently():
    r = row(tier="medium", cost=0.5, fee_day=12.0)  # 0.5%/h of fees
    assert profile_plan(r, _cfg("konservatif")) is None  # needs 1.5%
    assert profile_plan(r, _cfg("moderat")) is None  # needs 1.0%
    plan = profile_plan(r, _cfg("agresif"))  # 2h -> 1.0% >= 0.5%
    assert plan is not None and plan["profile"] == "agresif"
    assert math.isclose(plan["size_usd"], 60.0) and plan["exit"]["stop_loss_pct"] == 15.0
    assert plan["exit"]["min_hold_hours"] == 1.0


def test_profile_tiers_and_tvl_cap():
    cfg = _cfg("konservatif")
    assert profile_plan(row(tier="high", fee_day=500.0), cfg) is None
    plan = profile_plan(row(tier="low", fee_day=500.0, tvl=1_000.0), cfg)
    assert plan is not None and plan["size_usd"] == 20.0  # 2% of $1k TVL
    assert plan["exit"]["stop_loss_pct"] == 6.0


def test_pick_entries_uses_profile_plan():
    cfg = _cfg("agresif")
    picked = pick_entries([row(address="A", mint="X"), row(tier="low", address="B", mint="Y")], [], {}, cfg, 0)
    assert [p["address"] for p in picked] == ["A"]
    assert picked[0]["plan"]["profile"] == "agresif" and picked[0]["plan"]["size_usd"] == 60.0


def test_plan_params_for_backtest():
    base = PlanParams(portfolio_usd=1000, max_position_pct=5, hold_hours=4)
    agg = plan_params(PROFILE_BY_KEY["agresif"], base)
    assert agg.max_position_pct == 7.5 and agg.fee_gate_hours == 2.0 and agg.stop_loss_mult == 1.5
