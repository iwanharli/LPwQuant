from app.scoring import pump_flags


def token(**overrides):
    base = {"found": True, "is_banned": False, "usd_market_cap": 120_852_981.0, "ath_market_cap_usd": 449_957_637.0,
            "pumpswap_liquidity_usd": None}
    base.update(overrides)
    return base


def test_no_data_or_not_found_gives_no_flags():
    assert pump_flags(None, 100_000) == []
    assert pump_flags({"found": False, "is_banned": True}, 100_000) == []


def test_ath_drawdown_threshold():
    assert pump_flags(token(), 1_000_000) == ["ath_drawdown"]  # ANSEM: 27% of ATH
    assert pump_flags(token(usd_market_cap=200_000_000.0), 1_000_000) == []  # 44% of ATH
    assert pump_flags(token(ath_market_cap_usd=None), 1_000_000) == []


def test_banned_and_liquidity_elsewhere():
    flags = pump_flags(token(is_banned=True, usd_market_cap=400_000_000.0, pumpswap_liquidity_usd=900_000.0), 100_000)
    assert flags == ["pump_banned", "liquidity_elsewhere"]  # Meteora holds 10% of 1M
    assert pump_flags(token(usd_market_cap=400_000_000.0, pumpswap_liquidity_usd=100_000.0), 400_000) == []
