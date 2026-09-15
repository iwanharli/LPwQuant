import math

from app.depth import (
    Depth,
    bin_array_index,
    depth_per_bin_y,
    fee_for_position_pct_day,
    fee_share,
    new_bin_arrays,
    window_bins,
)


def depth(bins, initialized=(-2, -1, 0, 1, 2), active_id=35) -> Depth:
    return Depth.parse({"ts": 0, "active_id": active_id, "bin_step": 100, "array_lo": -2, "array_hi": 2,
                        "initialized": list(initialized), "bins": bins})


def test_window_bins_follows_typical_move():
    assert window_bins(100, None) == 1
    assert window_bins(100, 3.0) == 3  # ln(1.03)/ln(1.01) = 2.97
    assert window_bins(10, 50.0) == 35  # capped


def test_depth_per_bin_only_counts_the_window():
    d = depth([[-5, 1000.0], [-1, 10.0], [0, 20.0], [1, 30.0], [40, 5000.0]])
    assert math.isclose(depth_per_bin_y(d, 1), 60.0 / 3)


def test_fee_share_and_position_fee():
    assert fee_share(0, 100) == 0
    assert math.isclose(fee_share(100, 100), 0.5)
    # $1,000 fees/day (1% of $100k TVL); $100 over 10 bins against $10/bin depth earns half the fees.
    assert math.isclose(fee_for_position_pct_day(1.0, 100_000, 100, 10, 10.0), 500.0)
    # Spreading the same $100 over 100 bins earns far less per dollar.
    assert fee_for_position_pct_day(1.0, 100_000, 100, 100, 10.0) < 100.0


def test_depth_share_can_differ_a_lot_from_tvl_share():
    # TVL model: $100 in a $100k pool earns ~0.1% of fees. If only $1k of that TVL sits near price, the
    # per-bin model gives a much bigger share.
    tvl_share = 100 / (100_000 + 100)
    per_bin = fee_share(100 / 10, 1_000 / 10)
    assert per_bin > 50 * tvl_share


def test_new_bin_arrays_counts_missing_and_unknown():
    assert bin_array_index(-1) == -1 and bin_array_index(69) == 0 and bin_array_index(70) == 1
    d = depth([], initialized=(0,))  # active bin 35 sits in array 0
    assert new_bin_arrays(d, -10, 10) == 0
    assert new_bin_arrays(d, -40, 40) == 2  # needs arrays -1 and 1
    assert new_bin_arrays(d, -400, 0) is None  # beyond the scanned arrays
