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


def test_profiles_have_distinct_rules():
    assert [p.key for p in PROFILES] == ["konservatif", "moderat", "tenang", "satu_sisi", "bolak_balik", "tinggi_tenang", "agresif"]
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
    # 10% x 1.5 = 15%, capped by the profile's max_stop_loss_pct.
    assert math.isclose(plan["size_usd"], 60.0)
    assert plan["exit"]["stop_loss_pct"] == _cfg("agresif").max_stop_loss_pct
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


def test_plan_params_carry_the_tier_filter():
    # Without this the backtest cannot tell two profiles apart when tiers are all that separate them:
    # "tinggi_tenang" (high tier only) would score exactly like "tenang" (every tier).
    base = PlanParams(portfolio_usd=1000, max_position_pct=5, hold_hours=4)
    tenang = plan_params(PROFILE_BY_KEY["tenang"], base)
    tinggi = plan_params(PROFILE_BY_KEY["tinggi_tenang"], base)
    assert tenang.allowed_tiers == ("low", "medium", "high")
    assert tinggi.allowed_tiers == ("high",)
    assert tenang.allowed_tiers != tinggi.allowed_tiers
    assert plan_params(PROFILE_BY_KEY["konservatif"], base).allowed_tiers == ("low", "medium")


def test_tenang_profile_only_enters_calm_pools():
    cfg = paper_config(PROFILE_BY_KEY["tenang"])
    assert cfg.max_atr_pct == 2.0
    calm = {**row(tier="medium", fee_day=500.0), "market": {"atr_pct": 1.4}}
    wild = {**row(tier="medium", fee_day=500.0), "market": {"atr_pct": 6.0}}
    unknown = {**row(tier="medium", fee_day=500.0), "market": {}}
    assert profile_plan(calm, cfg, equity_usd=500.0) is not None
    assert profile_plan(wild, cfg, equity_usd=500.0) is None
    assert profile_plan(unknown, cfg, equity_usd=500.0) is None  # no ATR reading: stay out
    # The other profiles ignore volatility.
    assert profile_plan(wild, paper_config(PROFILE_BY_KEY["agresif"]), equity_usd=500.0) is not None


def test_satu_sisi_profile_trades_the_single_sided_plan():
    cfg = paper_config(PROFILE_BY_KEY["satu_sisi"])
    assert cfg.plan_variant == "single" and cfg.max_atr_pct == 2.0
    single = {"action": "enter", "tier": "medium", "size_usd": 40.0, "size_pct": 8.0, "strategy": "bid_ask",
              "side": "quote", "range_low_pct": -6.0, "range_high_pct": 0.0, "exit": dict(BASE_EXIT),
              "round_trip_cost_pct": 0.1, "fixed_cost_usd": 0.06, "fee_for_position_pct_day": 12.0}
    # The row's own (two-sided) fee estimate is healthy; the single-sided plan carries its own.
    r = {**row(tier="medium", fee_day=500.0), "market": {"atr_pct": 1.2}, "plan_single": single}
    plan = profile_plan(r, cfg, equity_usd=500.0)
    assert plan is not None and plan["side"] == "quote" and plan["range_high_pct"] == 0.0
    # Without a single-sided plan the profile stays out instead of falling back to the two-sided one.
    assert profile_plan({k: v for k, v in r.items() if k != "plan_single"}, cfg, equity_usd=500.0) is None
    # The gate uses the plan's own fee estimate, not the row's.
    thin = {**r, "plan_single": {**single, "fee_for_position_pct_day": 0.5}}
    assert profile_plan(thin, cfg, equity_usd=500.0) is None
    # Other profiles keep trading the two-sided plan.
    assert profile_plan(r, paper_config(PROFILE_BY_KEY["agresif"]), equity_usd=500.0) is not None


def test_position_size_never_exceeds_starting_capital():
    # Equity read $3.4M during the CHIP-USDC bug and sized positions at $169k; starting capital caps it.
    cfg = paper_config(PROFILE_BY_KEY["moderat"])
    r = {"address": "P", "tvl": 1e9, "fee_for_position_pct_day": 500.0,
         "plan_base": {"action": "enter", "tier": "high", "size_usd": 100.0, "size_pct": 20.0,
                       "exit": {"stop_loss_pct": 10.0, "out_of_range_minutes": 20.0, "fee_decay_ratio": 0.25,
                                "max_hold_hours": 8.0, "min_hold_hours": 2.0, "breakout_below_pct": None,
                                "breakout_above_pct": None},
                       "round_trip_cost_pct": 0.1, "fixed_cost_usd": 0.06}}
    plan = profile_plan(r, cfg, equity_usd=3_400_000.0)
    assert plan is not None and plan["size_usd"] <= cfg.start_equity_usd


def test_bolak_balik_only_enters_pools_that_keep_turning_back():
    cfg = paper_config(PROFILE_BY_KEY["bolak_balik"])
    assert cfg.min_reversal_rate == 0.5
    exit_rules = {"stop_loss_pct": 10.0, "out_of_range_minutes": 20.0, "fee_decay_ratio": 0.25, "max_hold_hours": 8.0,
                  "min_hold_hours": 2.0, "breakout_below_pct": None, "breakout_above_pct": None}
    base = {"address": "P", "tvl": 1_000_000.0, "fee_for_position_pct_day": 500.0,
            "plan_base": {"action": "enter", "tier": "medium", "size_usd": 100.0, "size_pct": 20.0,
                          "exit": exit_rules, "round_trip_cost_pct": 0.1, "fixed_cost_usd": 0.06}}
    assert profile_plan({**base, "market": {"reversal_rate": 0.62}}, cfg, equity_usd=500.0) is not None
    assert profile_plan({**base, "market": {"reversal_rate": 0.38}}, cfg, equity_usd=500.0) is None  # trending
    assert profile_plan({**base, "market": {}}, cfg, equity_usd=500.0) is None  # unknown is not a pass
