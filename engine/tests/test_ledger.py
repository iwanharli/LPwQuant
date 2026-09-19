from datetime import datetime, timedelta, timezone

from app import ledger

T = datetime(2026, 9, 19, 11, 50, tzinfo=timezone.utc)


def test_pack_payment_and_sale_count_as_gacha_but_real_money_does_not():
    gacha = [T]
    assert ledger.gacha_related(T - timedelta(minutes=2), -10.0, gacha)   # paying for the pack
    assert ledger.gacha_related(T + timedelta(minutes=5), 8.03, gacha)    # card sold back
    assert not ledger.gacha_related(T + timedelta(hours=2), 8.03, gacha)  # too far apart
    assert not ledger.gacha_related(T, 2055.0, gacha)                     # a top-up is capital
    assert not ledger.gacha_related(T, -10.0, [])                         # no gacha at all


def test_money_folds_native_and_wrapped_sol_with_usdc():
    row = {"sol_delta": 0.5, "deltas": [{"mint": ledger.USDC, "amount": -10.0}, {"mint": ledger.SOL, "amount": 0.25}]}
    assert abs(ledger._money(row, 100.0) - 65.0) < 1e-9
