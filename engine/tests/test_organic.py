from app.scoring import organic_flags, score_pool

NOW = 1_800_000_000_000


def organic(score, label, bots=1.0):
    return {"organic_score": score, "organic_label": label, "bot_holders_pct": bots}


def pool(verified=False, market_cap=5_000_000):
    token = {"mint": "MEME", "symbol": "MEME", "verified": verified, "holders": 5_000, "market_cap": market_cap,
             "freeze_disabled": True}
    quote = {"mint": "So11111111111111111111111111111111111111112", "symbol": "SOL", "verified": True}
    return {"tvl": 100_000.0, "fee_tvl_pct": {"24h": 2.0, "4h": 0.4, "1h": 0.1}, "volume": {"24h": 500_000.0},
            "token_x": token, "token_y": quote, "pool_created_at": NOW - 48 * 3_600_000, "base_fee_pct": 0.2,
            "dynamic_fee_pct": 0.0}


SECURITY = {"rugged": False, "mint_authority": False, "freeze_authority": False, "top10_pct": 10.0, "risks": []}


def test_organic_flags_thresholds():
    assert organic_flags(None) == []
    assert organic_flags(organic(96.1, "high")) == []
    assert organic_flags(organic(55.0, "medium")) == ["organic_weak"]
    assert organic_flags(organic(0.0, "low")) == ["organic_low"]
    assert organic_flags(organic(38.5, "medium")) == ["organic_low"]
    assert organic_flags(organic(90.0, "high", bots=13.0)) == ["bot_holders_heavy"]


def _safety(org, **pool_kwargs):
    return score_pool(pool(**pool_kwargs), 0.0, 2.0, NOW, SECURITY, 50.0, organic=org)


def test_low_organic_and_bot_holders_cost_safety():
    clean = _safety(organic(90.0, "high"))
    low = _safety(organic(0.0, "low", bots=20.0))
    assert "organic_low" in low["flags"] and "bot_holders_heavy" in low["flags"]
    assert clean["safety"] - low["safety"] == 13.0
    weak = _safety(organic(50.0, "medium"))
    assert "organic_weak" in weak["flags"] and weak["safety"] == clean["safety"]


def test_issuer_tokens_are_exempt():
    issuer = _safety(organic(0.0, "low", bots=20.0), verified=True, market_cap=200_000_000)
    assert "organic_low" not in issuer["flags"] and "bot_holders_heavy" not in issuer["flags"]
