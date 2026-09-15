from app.tiers import classify_tier, excluded_reason, volatility_pct


def tier(**overrides):
    kwargs = dict(safety=30.0, flags=[], tvl=500_000.0, vol_pct=1.5, regime="ranging")
    kwargs.update(overrides)
    return classify_tier(**kwargs)[0]


def test_low_medium_high_boundaries():
    assert tier() == "low"
    assert tier(vol_pct=3.0) == "medium"
    assert tier(tvl=50_000.0) == "medium"
    assert tier(safety=20.0) == "medium"
    assert tier(regime="trending_down") == "medium"
    assert tier(vol_pct=7.0) == "high"
    assert tier(tvl=10_000.0) == "high"
    assert tier(safety=10.0) == "high"
    assert tier(flags=["strong_downtrend"]) == "high"


def test_severe_flags_and_low_safety_are_excluded():
    assert tier(flags=["mint_authority"]) is None
    assert tier(flags=["pumping"]) is None
    assert tier(safety=5.0) is None
    assert "mint_authority" in excluded_reason(["mint_authority", "unverified"], 30.0)
    assert excluded_reason(["unverified"], 30.0) is None


def test_high_tier_reason_lists_causes():
    _, reason = classify_tier(safety=10.0, flags=[], tvl=5_000.0, vol_pct=9.0, regime="mixed")
    assert "keamanan" in reason and "volatil" in reason and "TVL" in reason


def test_volatility_prefers_atr():
    assert volatility_pct(2.5, 10.0) == 2.5
    assert volatility_pct(None, 10.0) == 7.0
    assert volatility_pct(None, None) is None
