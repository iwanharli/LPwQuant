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


def _t(h):
    return datetime(2026, 9, 1, h, tzinfo=timezone.utc).timestamp()


def test_buy_lp_sell_is_its_own_cash():
    """Each position earns what its own buy, LP and sell moved, not a share of its neighbours' swaps."""
    coin = {"net": -1.0, "txs": [
        # position a: bought 100 for 10, sold the 100 for 8 -> -2 (Meteora said +0.5)
        {"kind": "swap", "ts": _t(1), "cash": -10.0, "qty": 100.0},
        {"kind": "add_liquidity", "ts": _t(2), "cash": -5.0, "qty": -100.0, "position": "a"},
        {"kind": "remove_liquidity", "ts": _t(3), "cash": 5.0, "qty": 100.0, "position": "a"},
        {"kind": "swap", "ts": _t(3), "cash": 8.0, "qty": -100.0},
        # position b: bought 100 for 10, sold the 100 for 11 -> +1 (Meteora said -0.5)
        {"kind": "swap", "ts": _t(5), "cash": -10.0, "qty": 100.0},
        {"kind": "add_liquidity", "ts": _t(6), "cash": -5.0, "qty": -100.0, "position": "b"},
        {"kind": "remove_liquidity", "ts": _t(7), "cash": 5.0, "qty": 100.0, "position": "b"},
        {"kind": "swap", "ts": _t(7), "cash": 11.0, "qty": -100.0},
    ]}
    flows = {"in_x": 100.0, "out_x": 100.0, "entry_px": 0.1, "exit_px": 0.1}
    ps = netpnl._split_positions(coin, [{**_pos("a", 2, 3, 0.5), **flows}, {**_pos("b", 6, 7, -0.5), **flows}])
    assert abs(ps[0]["net"] - (-2.0)) < 1e-9
    assert abs(ps[1]["net"] - 1.0) < 1e-9


def test_tokens_rolled_into_the_next_position_count_once():
    """Bought for a, carried into b without selling: a is credited the tokens at its exit price, b pays that
    same price at its entry, and the two still add up to the coin."""
    coin = {"net": 3.0, "txs": [
        {"kind": "swap", "ts": _t(1), "cash": -10.0, "qty": 100.0},
        {"kind": "add_liquidity", "ts": _t(2), "cash": -5.0, "qty": -100.0, "position": "a"},
        {"kind": "remove_liquidity", "ts": _t(3), "cash": 5.0, "qty": 100.0, "position": "a"},
        {"kind": "add_liquidity", "ts": _t(4), "cash": -5.0, "qty": -100.0, "position": "b"},
        {"kind": "remove_liquidity", "ts": _t(5), "cash": 5.0, "qty": 100.0, "position": "b"},
        {"kind": "swap", "ts": _t(5), "cash": 13.0, "qty": -100.0},
    ]}
    a = {**_pos("a", 2, 3, 0.0), "in_x": 100.0, "out_x": 100.0, "entry_px": 0.1, "exit_px": 0.12}
    b = {**_pos("b", 4, 5, 0.0), "in_x": 100.0, "out_x": 100.0, "entry_px": 0.12, "exit_px": 0.13}
    ps = netpnl._split_positions(coin, [a, b])
    assert abs(ps[0]["net"] - 2.0) < 1e-9   # -10 bought, tokens out worth 12
    assert abs(ps[1]["net"] - 1.0) < 1e-9   # tokens in worth 12, sold for 13
    assert abs(sum(p["net"] for p in ps) - coin["net"]) < 1e-9
