import math

from app.costs import CostModel, fixed_cost_usd, resized_cost_pct
from app.paper import profile_plan, verdict
from app.profiles import PROFILE_BY_KEY, paper_config
from app.scoring import tvl_flags


def _cfg(key):
    """Profile config without the paper position floor, so sizing and gating rules are tested on their own."""
    from dataclasses import replace

    return replace(paper_config(PROFILE_BY_KEY[key]), position_floor_usd=0.0)

EXIT = {"stop_loss_pct": 10.0, "out_of_range_minutes": 20.0, "fee_decay_ratio": 0.25, "max_hold_hours": 8.0,
        "breakout_below_pct": None, "breakout_above_pct": None, "min_hold_hours": 2.0}


def row(size_usd=50.0, size_pct=5.0, cost=0.5, fixed=0.0, fee_day=48.0, tvl=1_000_000.0, tier="medium"):
    base = {"action": "enter", "tier": tier, "size_usd": size_usd, "size_pct": size_pct, "exit": dict(EXIT),
            "round_trip_cost_pct": cost, "fixed_cost_usd": fixed}
    return {"address": "POOL", "tvl": tvl, "fee_for_position_pct_day": fee_day, "plan_base": base,
            "plan": {"action": "wait", "reason": "gated"}}


def test_size_follows_profile_equity():
    cfg = _cfg("agresif")  # size x1.5
    assert profile_plan(row(), cfg)["size_usd"] == 75.0  # no equity given: plan size
    assert profile_plan(row(), cfg, equity_usd=500.0)["size_usd"] == 37.5  # 5% of $500 x 1.5
    assert profile_plan(row(tvl=1_000.0), cfg, equity_usd=500.0)["size_usd"] == 20.0  # 2% TVL cap


def test_fixed_costs_weigh_more_on_smaller_positions():
    assert math.isclose(resized_cost_pct(1.0, 0.1, 50.0, 25.0), 0.8 + 0.4)
    assert resized_cost_pct(1.0, 0.1, 50.0, 100.0) < 1.0
    model = CostModel(tx_cost_sol=0.001)
    assert math.isclose(fixed_cost_usd(2, 100, 150.0, model), 2 * 4 * 0.001 * 150.0)
    assert math.isclose(fixed_cost_usd(1, 70, 150.0, model, new_bin_arrays=1), (4 * 0.001 + model.bin_array_rent_sol) * 150.0)
    assert fixed_cost_usd(1, 70, 150.0, CostModel(enabled=False)) == 0.0


def test_cost_gate_uses_cost_at_the_profile_size():
    cfg = _cfg("moderat")  # fee >= 2x cost over 1h
    # 1h fees 1%/h (24%/day). At the $50 plan size: cost 0.5% -> passes. At 5% of $100 equity ($5), the $0.2 fixed
    # part alone is 4%: fails.
    r = row(cost=0.5, fixed=0.2, fee_day=24.0)
    assert profile_plan(r, cfg) is not None
    assert profile_plan(r, cfg, equity_usd=100.0) is None
    sized = profile_plan(r, cfg, equity_usd=2_000.0)  # $100 position: 0.1% variable + 0.2% fixed
    assert sized is not None and math.isclose(sized["round_trip_cost_pct"], 0.3)


def test_verdict_rule():
    assert verdict({"trades": 10, "ci_low": 1.0, "ci_high": 2.0}) == {"status": "collecting", "trades": 10, "trades_needed": 40}
    assert verdict({"trades": 60, "ci_low": 0.1, "ci_high": 2.0})["status"] == "profitable"
    assert verdict({"trades": 60, "ci_low": -3.0, "ci_high": -0.2})["status"] == "losing"
    assert verdict({"trades": 60, "ci_low": -0.5, "ci_high": 1.0})["status"] == "inconclusive"


def test_tvl_flags():
    assert tvl_flags(64_727_986, 15_526_592, 6_073_715) == ["tvl_suspect"]  # ANTFUN-USDT
    assert tvl_flags(3_924_292, 1_632_492, 4_183_000) == []  # MU-USDC: bins hold the TVL
    assert tvl_flags(571_663, 95_096, None) == ["tvl_unverified"]  # tSpaceX: no on-chain depth read
    assert tvl_flags(100_000, 500_000, 1_000) == []  # plausible TVL, depth not needed
    assert tvl_flags(100_000, None, None) == []


def test_position_floor_and_capital_limit():
    from dataclasses import replace

    from app.paper import pick_entries

    cfg = replace(paper_config(PROFILE_BY_KEY["moderat"]), position_floor_usd=100.0, min_fee_cost_ratio=None)
    live = {"action": "enter", "tier": "medium", "size_usd": 50.0, "size_pct": 1.0, "exit": dict(EXIT)}
    r = {"address": "A", "base_mint": "MA", "price": 1.0, "score": 60, "tvl": 1_000_000.0, "plan": live}
    assert profile_plan(r, cfg, equity_usd=500.0)["size_usd"] == 100.0  # 1% of $500 = $5, floored
    small_pool = dict(r, tvl=2_000.0)
    assert profile_plan(small_pool, cfg, equity_usd=500.0)["size_usd"] == 40.0  # floor still capped at 2% TVL
    rows = [dict(r, address=a, base_mint="M" + a, score=100 - i) for i, a in enumerate("ABCDEFG")]
    picked = pick_entries(rows, [], {}, replace(cfg, max_open_per_tier=10), 0, equity_usd=500.0)
    assert [p["address"] for p in picked] == list("ABCDE")  # 5 x $100 = all $500 of equity committed
