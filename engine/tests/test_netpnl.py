from datetime import datetime, timezone

from app import netpnl


def _pos(name, opened, closed, pnl, dep=100.0):
    ts = lambda h: datetime(2026, 9, 1, h, tzinfo=timezone.utc) if h is not None else None  # noqa: E731
    return {"position": name, "pool": "P", "status": "closed" if closed else "open", "opened_at": ts(opened),
            "closed_at": ts(closed), "meteora_pnl_usd": pnl, "fees_usd": 1.0, "deposit_usd": dep}


def test_positions_add_up_to_the_coin_and_follow_their_swaps():
    t = lambda h: datetime(2026, 9, 1, h, tzinfo=timezone.utc).timestamp()  # noqa: E731
    coin = {"net": -50.0, "txs": [
        {"kind": "swap", "ts": t(1), "cash": -100.0},  # bought before the first position closed
        {"kind": "swap", "ts": t(5), "cash": 60.0},    # sold before the second closed
        {"kind": "add_liquidity", "ts": t(2), "cash": -10.0},
    ]}
    ps = netpnl._split_positions(coin, [_pos("a", 0, 3, 10.0), _pos("b", 4, 6, 20.0)])
    assert abs(sum(p["net"] for p in ps) - coin["net"]) < 1e-9
    # outside LP = -50 - 30 = -80, shared 100:60 by swap volume
    assert abs(ps[0]["outside_share"] - (-80 * 100 / 160)) < 1e-9
    assert ps[0]["swaps"] == 1 and ps[1]["swaps"] == 1


def test_no_swaps_shares_by_deposit():
    ps = netpnl._split_positions({"net": 0.0, "txs": []}, [_pos("a", 0, 1, 10.0, dep=300), _pos("b", 2, 3, -10.0, dep=100)])
    assert abs(sum(p["net"] for p in ps)) < 1e-9
