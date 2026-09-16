import math
from dataclasses import replace

from app.costs import CostModel, swap_cost_fraction
from app.paper import profile_plan
from app.profiles import PROFILE_BY_KEY, paper_config
from app.recommend import PlanParams, apply_cost_gate

MODEL = CostModel()
POOL = {"base_fee_pct": 0.2, "dynamic_fee_pct": 0.0, "tvl": 100_000.0, "bin_step": 100}
EXIT = {"stop_loss_pct": 20.0, "out_of_range_minutes": 20.0, "fee_decay_ratio": 0.25, "max_hold_hours": 8.0,
        "min_hold_hours": 2.0, "breakout_below_pct": None, "breakout_above_pct": None}


def test_impact_uses_bin_depth_when_available():
    # $100 through $500/bin crosses 0.2 bins of 1% each: ~0.1% average impact, on top of the 0.2% pool fee.
    deep = dict(POOL, depth_per_bin_usd=500.0)
    assert math.isclose(swap_cost_fraction(deep, 100.0, MODEL), 0.002 + 0.001)
    # A shallow pool with the same TVL is far more expensive than the TVL model suggests: $100 through $20/bin
    # crosses 5 bins, so ~2.5% average impact.
    shallow = dict(POOL, depth_per_bin_usd=20.0)
    assert math.isclose(swap_cost_fraction(shallow, 100.0, MODEL), 0.002 + 0.025)
    assert swap_cost_fraction(shallow, 100.0, MODEL) > swap_cost_fraction(POOL, 100.0, MODEL)
    assert swap_cost_fraction(dict(POOL, depth_per_bin_usd=1.0), 100.0, MODEL) == 0.002 + MODEL.max_impact
    assert math.isclose(swap_cost_fraction(POOL, 100.0, MODEL), 0.002 + 100 / 100_000)  # no depth: TVL fallback


def test_plan_rejected_above_the_cost_cap():
    params = PlanParams(portfolio_usd=1000, max_position_pct=5, hold_hours=4)
    plan = {"action": "enter", "tier": "high", "regime": "ranging"}
    blocked = apply_cost_gate(plan, 2.3, 10_000.0, params)  # huge fees, but the round trip costs 2.3%
    assert blocked["action"] == "wait" and "batas" in blocked["reason"] and blocked["gated_tier"] == "high"
    assert apply_cost_gate(plan, 1.4, 10_000.0, params)["action"] == "enter"


def test_profile_rejects_expensive_round_trips():
    cfg = paper_config(PROFILE_BY_KEY["agresif"])
    row = {"address": "P", "tvl": 1_000_000.0, "fee_for_position_pct_day": 500.0,
           "plan_base": {"action": "enter", "tier": "high", "size_usd": 100.0, "size_pct": 20.0, "exit": dict(EXIT),
                         "round_trip_cost_pct": 2.5, "fixed_cost_usd": 0.06}}
    assert profile_plan(row, cfg, equity_usd=500.0) is None
    cheap = {**row, "plan_base": {**row["plan_base"], "round_trip_cost_pct": 0.4}}
    assert profile_plan(cheap, cfg, equity_usd=500.0) is not None


def test_stop_loss_is_capped_after_the_profile_multiplier():
    cfg = paper_config(PROFILE_BY_KEY["agresif"])  # stop_loss_mult 1.5
    row = {"address": "P", "tvl": 1_000_000.0, "plan": {"action": "enter", "tier": "high", "size_usd": 100.0,
                                                        "size_pct": 20.0, "exit": dict(EXIT)}}
    plan = profile_plan(row, replace(cfg, min_fee_cost_ratio=None), equity_usd=500.0)
    assert plan["exit"]["stop_loss_pct"] == cfg.max_stop_loss_pct  # 20% x 1.5 capped at 10%
