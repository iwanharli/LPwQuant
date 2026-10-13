from app.copy_paper import small_fit


def _w(**kw):
    base = {"deposit_median_usd": 120.0, "median_pct": 3.0, "hold_median_h": 24.0, "without_best3_usd": 500.0,
            "lifetime_pnl_usd": 8000.0, "positions_7d": 4}
    return {**base, **kw}


def test_small_patient_profitable_wallet_fits():
    assert small_fit(_w())


def test_rejects_big_thin_fast_or_lucky_wallets():
    assert not small_fit(_w(deposit_median_usd=1200.0))  # too big for a $100 copy to mirror
    assert not small_fit(_w(median_pct=0.2))  # margin eaten by fixed costs
    assert not small_fit(_w(hold_median_h=1.0))  # scalper
    assert not small_fit(_w(without_best3_usd=-10.0))  # carried by three positions
    assert not small_fit(_w(positions_7d=0))  # not active this week
