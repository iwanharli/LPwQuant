from app.portfolio import exit_side_from_flows, in_range_share

M = 60_000
T0 = 1_000_000 * M  # 13:10
# JACK/SOL 5m candles on 27 Sep (low, high, close); 13:10 and 13:15.
CANDLES = [(T0, 1.764e-5, 1.949e-5, 1.949e-5), (T0 + 5 * M, 1.925e-5, 2.348e-5, 2.234e-5)]


def test_short_position_mostly_inside_is_not_zero():
    # Position 13:11 -> 13:19, range 1.578e-5 .. 2.074e-5: inside the whole first candle, left the top in the second.
    pct, last = in_range_share(CANDLES, 5 * M, T0 + M, T0 + 9 * M, 1.578e-5, 2.074e-5)
    assert 55 < pct < 85
    assert last == 2.234e-5


def test_exit_side_from_what_came_out():
    assert exit_side_from_flows({"amount_x_out": 0.0, "amount_y_out": 0.094}) == "above"
    assert exit_side_from_flows({"amount_x_out": 1367.9, "amount_y_out": 0.18}) == "inside"
    assert exit_side_from_flows({"amount_x_out": 241617.9, "amount_y_out": 0.0}) == "below"
    assert exit_side_from_flows({}) is None
