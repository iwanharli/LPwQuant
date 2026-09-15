import math

from app.depth import (
    Depth,
    bin_array_index,
    calibrated_fee_share,
    depth_per_bin_y,
    fee_for_position_pct_day,
    new_bin_arrays,
    realization_factor,
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


def test_realization_depends_on_range_width():
    assert realization_factor(1) == 1.0 and realization_factor(70) == 1.0
    assert realization_factor(71) == 0.65


def test_calibrated_fee_share_is_tvl_share_times_realization():
    assert calibrated_fee_share(0, 100_000, 10) == 0.0
    assert math.isclose(calibrated_fee_share(100, 99_900, 30), 100 / 100_000)
    assert math.isclose(calibrated_fee_share(100, 99_900, 200), 0.65 * 100 / 100_000)


def test_fee_for_position_pct_day():
    # $1,000 fees/day on $100k TVL; a $100 narrow position earns its 0.1% TVL share = $1/day = 1% of itself.
    assert math.isclose(fee_for_position_pct_day(1.0, 100_000, 100, 30), 1000 * 100 / 100_100 / 100 * 100)
    wide = fee_for_position_pct_day(1.0, 100_000, 100, 300)
    assert math.isclose(wide, 0.65 * fee_for_position_pct_day(1.0, 100_000, 100, 30))
    assert fee_for_position_pct_day(1.0, 0, 100, 30) == 0.0


def test_new_bin_arrays_counts_missing_and_unknown():
    assert bin_array_index(-1) == -1 and bin_array_index(69) == 0 and bin_array_index(70) == 1
    d = depth([], initialized=(0,))  # active bin 35 sits in array 0
    assert new_bin_arrays(d, -10, 10) == 0
    assert new_bin_arrays(d, -40, 40) == 2  # needs arrays -1 and 1
    assert new_bin_arrays(d, -400, 0) is None  # beyond the scanned arrays
