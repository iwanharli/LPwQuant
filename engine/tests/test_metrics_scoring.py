import math

from app.metrics import PriceHistory
from app.scoring import QUOTE_MINTS, base_token, diluted_fee_pct, expected_fee_pct_day, score_pool

HOUR = 3_600_000
SOL = "So11111111111111111111111111111111111111112"
CLEAN_SECURITY = {"rugged": False, "mint_authority": False, "freeze_authority": False,
                  "top10_pct": 12.0, "risks": []}


def test_history_drops_old_and_out_of_order_points():
    h = PriceHistory()
    h.add(0, 1.0, max_age_ms=HOUR)
    h.add(HOUR // 2, 1.1, max_age_ms=HOUR)
    h.add(HOUR // 4, 9.9, max_age_ms=HOUR)  # out of order, ignored
    h.add(2 * HOUR, 1.2, max_age_ms=HOUR)  # evicts ts=0 and ts=HOUR/2
    assert [p for _, p in h.points] == [1.2]


def test_change_requires_half_window_coverage():
    h = PriceHistory()
    h.add(0, 100.0, HOUR * 2)
    h.add(10 * 60_000, 110.0, HOUR * 2)
    assert h.change_pct(10 * 60_000, HOUR) is None
    h.add(HOUR, 90.0, HOUR * 2)
    assert math.isclose(h.change_pct(HOUR, HOUR), -10.0)


def test_realized_vol_is_root_sum_of_squared_log_returns():
    h = PriceHistory()
    for i, price in enumerate([100.0, 110.0, 99.0]):
        h.add(i * 60_000, price, HOUR)
    expected = math.sqrt(math.log(1.1) ** 2 + math.log(0.9) ** 2) * 100
    assert math.isclose(h.realized_vol_pct(3 * 60_000, HOUR), expected)


def _pool(**overrides):
    token = {"mint": "MEME", "symbol": "MEME", "verified": True, "holders": 5000,
             "freeze_disabled": True, "market_cap": 5_000_000}
    pool = {
        "tvl": 100_000.0,
        "fee_tvl_pct": {"1h": 0.5, "4h": 2.0, "24h": 10.0},
        "volume": {"24h": 1_000_000.0},
        "pool_created_at": 0,
        "token_x": token,
        "token_y": {"mint": SOL, "symbol": "SOL"},
    }
    pool.update(overrides)
    return pool


def test_base_token_is_non_quote_side():
    assert SOL in QUOTE_MINTS
    swapped = _pool(token_x={"mint": SOL}, token_y={"mint": "MEME"})
    assert base_token(swapped)["mint"] == "MEME"
    assert base_token(_pool())["mint"] == "MEME"


def test_expected_fee_weights_recent_windows_and_dilution():
    assert math.isclose(expected_fee_pct_day({"24h": 10, "4h": 2, "1h": 0.5}), 2 + 4.8 + 4.8)
    assert math.isclose(diluted_fee_pct(10, 100_000, 100_000), 5)


def test_clean_pool_has_no_penalties():
    now = 48 * HOUR
    clean = score_pool(_pool(), 2.0, 5.0, now, CLEAN_SECURITY, position_usd=50)
    assert clean["flags"] == []
    assert clean["safety"] == 30


def test_red_flags_lower_score_and_are_reported():
    now = 48 * HOUR
    clean = score_pool(_pool(), 2.0, 5.0, now, CLEAN_SECURITY, position_usd=50)

    risky_token = dict(_pool()["token_x"], holders=10)
    risky_security = dict(CLEAN_SECURITY, mint_authority=True, top10_pct=60.0,
                          risks=[{"name": "Permanent Control Enabled", "level": "danger"}])
    risky = score_pool(_pool(token_x=risky_token), -30.0, 40.0, now, risky_security, position_usd=50)
    assert {"mint_authority", "top_holders_50", "rugcheck_danger", "low_holders", "dumping",
            "high_volatility"} <= set(risky["flags"])
    assert risky["score"] < clean["score"]
    assert 0 <= risky["score"] <= clean["score"] <= 100

    pending = score_pool(_pool(), 2.0, 5.0, now, None, position_usd=50)
    assert "security_pending" in pending["flags"]


def test_covered_risks_are_not_double_penalized():
    now = 48 * HOUR
    sec = dict(CLEAN_SECURITY, mint_authority=True, risks=[
        {"name": "Mint Authority still enabled", "level": "danger"},
        {"name": "Large Amount of LP Unlocked", "level": "danger"},
    ])
    scored = score_pool(_pool(), 2.0, 5.0, now, sec, position_usd=50)
    assert "mint_authority" in scored["flags"]
    assert "rugcheck_danger" not in scored["flags"]
    assert scored["safety"] == 15


def test_large_verified_issuer_token_is_not_penalized_for_authorities():
    now = 48 * HOUR
    wrapped = dict(_pool()["token_x"], market_cap=2_000_000_000, freeze_disabled=False)
    sec = dict(CLEAN_SECURITY, mint_authority=True, freeze_authority=True, top10_pct=70.0)
    scored = score_pool(_pool(token_x=wrapped), 0.5, 1.0, now, sec, position_usd=50)
    assert "issuer_controlled" in scored["flags"]
    assert not {"mint_authority", "freeze_authority", "top_holders_50"} & set(scored["flags"])
    assert scored["safety"] == 30

    unverified = dict(wrapped, verified=False)
    assert "mint_authority" in score_pool(_pool(token_x=unverified), 0.5, 1.0, now, sec, 50)["flags"]


def test_market_flags_penalize_downtrend_and_sell_pressure():
    now = 48 * HOUR
    ranging = score_pool(_pool(), 1.0, 3.0, now, CLEAN_SECURITY, 50, {"regime": "ranging"})
    assert "sideways" in ranging["flags"] and ranging["safety"] == 30

    falling = {"regime": "trending_down", "adx": 35, "ema_slope_pct": -1.2, "sell_pressure": True, "drawdown_pct": -40}
    risky = score_pool(_pool(), -5.0, 3.0, now, CLEAN_SECURITY, 50, falling)
    assert {"strong_downtrend", "sell_pressure", "deep_drawdown"} <= set(risky["flags"])
    assert risky["safety"] == 30 - 8 - 5 - 5
    assert risky["score"] < ranging["score"]


def test_pump_and_extreme_volatility_flags():
    now = 48 * HOUR
    pumped = score_pool(_pool(), 45.0, 10.0, now, CLEAN_SECURITY, 50, {"regime": "mixed", "atr_pct": 9.5})
    assert {"pumping", "extreme_volatility"} <= set(pumped["flags"])
    assert pumped["safety"] == 30 - 10 - 5


def test_gmgn_insight_flags_penalize_insiders():
    now = 48 * HOUR
    insights = {
        "dev": {"launches": 312, "hold_pct": 7.5, "boost_ts": (now - HOUR) // 1000, "ad_ts": None},
        "tags": {
            "bundler": {"count": 12, "holding_pct": 22.0, "netflow_usd": 5_000},
            "sniper": {"count": 4, "holding_pct": 3.0, "netflow_usd": 0},
            "smart_degen": {"count": 5, "holding_pct": 1.2, "netflow_usd": -40_000},
        },
    }
    scored = score_pool(_pool(), 1.0, 3.0, now, CLEAN_SECURITY, 50, None, insights)
    assert {"serial_dev", "dev_holds", "bundler_heavy", "smart_money_exit", "paid_hype"} <= set(scored["flags"])
    assert "sniper_heavy" not in scored["flags"]
    assert scored["safety"] == 30 - 3 - 5 - 8 - 5

    old_boost = dict(insights, dev=dict(insights["dev"], boost_ts=(now - 3 * 24 * HOUR) // 1000))
    assert "paid_hype" not in score_pool(_pool(), 1.0, 3.0, now, CLEAN_SECURITY, 50, None, old_boost)["flags"]

    # Missing GMGN data is neutral.
    assert score_pool(_pool(), 1.0, 3.0, now, CLEAN_SECURITY, 50, None, None)["safety"] == 30


def test_gmgn_flags_skipped_for_large_issuer_tokens():
    now = 48 * HOUR
    wrapped = dict(_pool()["token_x"], market_cap=2_000_000_000)
    insights = {"dev": {"launches": 500, "hold_pct": 40.0}, "tags": {"bundler": {"holding_pct": 60.0}}}
    scored = score_pool(_pool(token_x=wrapped), 1.0, 3.0, now, CLEAN_SECURITY, 50, None, insights)
    assert not {"serial_dev", "dev_holds", "bundler_heavy"} & set(scored["flags"])


def test_rugged_caps_score_and_small_tvl_scores_lower():
    now = 48 * HOUR
    rugged = score_pool(_pool(), 2.0, 5.0, now, dict(CLEAN_SECURITY, rugged=True), position_usd=50)
    assert rugged["score"] <= 10 and "rugged" in rugged["flags"]

    small = score_pool(_pool(tvl=15_000.0), 2.0, 5.0, now, CLEAN_SECURITY, position_usd=50)
    big = score_pool(_pool(tvl=800_000.0), 2.0, 5.0, now, CLEAN_SECURITY, position_usd=50)
    assert "thin_liquidity" in small["flags"]
    assert small["score"] < big["score"]
