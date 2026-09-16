from app.recommend import PlanParams, plan_position

BASE = PlanParams(portfolio_usd=500, max_position_pct=5, hold_hours=4)
RANGING = {"regime": "ranging", "atr_pct": 4.0, "donchian_low_pct": -8.0, "donchian_high_pct": 9.0}
TRENDING = {"regime": "trending_up", "atr_pct": 4.0}


def plan(params, market, **kwargs):
    args = dict(bin_step=20, tvl=500_000.0, score=70.0, safety=25.0, flags=[], change_pct_1h=1.0,
                realized_vol_pct_1h=4.0, fee_for_position_pct_day=10.0, params=params, market=market)
    args.update(kwargs)
    return plan_position(**args)


def test_max_bins_narrows_the_range():
    wide = plan(BASE, RANGING)
    narrow = plan(replace_params(max_bins=70), RANGING)
    assert wide["bins"] > 70
    assert narrow["bins"] <= 70
    assert abs(narrow["range_low_pct"]) < abs(wide["range_low_pct"])


def replace_params(**kwargs):
    from dataclasses import replace

    return replace(BASE, **kwargs)


def test_require_ranging_skips_trends():
    assert plan(replace_params(require_ranging=True), TRENDING)["action"] == "wait"
    assert plan(replace_params(require_ranging=True), RANGING)["action"] == "enter"
    assert plan(BASE, TRENDING)["action"] == "enter"  # default still trades trends


def test_force_side_quote_is_single_sided():
    p = plan(replace_params(force_side="quote"), RANGING)
    assert p["strategy"] == "bid_ask" and p["side"] == "quote"
    assert p["range_high_pct"] == 0.0 and p["range_low_pct"] < 0
