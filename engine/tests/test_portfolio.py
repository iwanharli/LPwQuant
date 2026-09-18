from datetime import datetime, timezone

from app import portfolio


def _row(ts, open_pnl, closed=0.0, value=100.0):
    return {"ts": datetime.fromisoformat(ts).replace(tzinfo=timezone.utc), "open_pnl_usd": open_pnl,
            "closed_pnl_usd": closed, "open_pnl_sol": 0.0, "closed_pnl_sol": 0.0, "value_usd": value}


def test_wallet_validation():
    assert portfolio.valid_wallet("HAWK3BVnwptKRFYfVoVGhBc2TYxpyG9jmAbkHeW9tyKE")
    assert not portfolio.valid_wallet("0xabc")
    assert not portfolio.valid_wallet("HAWK3BVnwptKRFYfVoVGhBc2TYxpyG9jmAbkHeW9tyK0")  # 0 is not base58


def test_daily_pnl_uses_previous_close_and_survives_a_position_closing():
    rows = [
        _row("2026-09-17T02:00", 1.0),   # 09:00 WIB, day 1 open
        _row("2026-09-17T15:00", 3.0),   # 22:00 WIB, day 1 close
        _row("2026-09-18T01:00", 4.0),   # 08:00 WIB day 2
        _row("2026-09-18T10:00", 0.0, closed=6.0),  # position closed: PnL moved from open to closed
    ]
    days = portfolio.daily_pnl(rows)
    assert [d["day"] for d in days] == ["2026-09-17", "2026-09-18"]
    assert days[0]["pnl_usd"] == 2.0 and days[0]["partial"]
    assert days[1]["pnl_usd"] == 3.0 and not days[1]["partial"]
