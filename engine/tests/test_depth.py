import math

from app.depth import (
    fee_rate_realization,
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
    # $1,000 fees/day on $100k TVL; a $100 narrow position earns its 0.1% TVL share = $1/day = 1% of itself,
    # then shrunk by fee_rate_realization: entry fee rates are not what a position goes on to collect.
    share = 1000 * 100 / 100_100 / 100 * 100
    narrow = fee_for_position_pct_day(1.0, 100_000, 100, 30)
    assert math.isclose(narrow, share * fee_rate_realization(share))
    assert narrow < share
    # A wide range still earns less than a narrow one, but not exactly 0.65x: each level of fees gets its own
    # shrink, and a lower rate keeps a larger share of itself.
    wide = fee_for_position_pct_day(1.0, 100_000, 100, 300)
    assert wide < narrow
    assert 0.65 * narrow < wide < 0.9 * narrow
    assert fee_for_position_pct_day(1.0, 0, 100, 30) == 0.0


def test_fee_rate_realization_shrinks_hot_pools_hardest():
    # Measured on 481 backtested trades: <10%/day kept 0.51x, >=50%/day only 0.25x. Fee spikes mean-revert.
    assert fee_rate_realization(0) == 1.0
    assert fee_rate_realization(0.1) == 1.0  # calm pools: capped, no shrink
    assert fee_rate_realization(5) > fee_rate_realization(20) > fee_rate_realization(80)
    assert 0.4 < fee_rate_realization(10) < 0.6
    assert 0.2 < fee_rate_realization(80) < 0.3


def test_new_bin_arrays_counts_missing_and_unknown():
    assert bin_array_index(-1) == -1 and bin_array_index(69) == 0 and bin_array_index(70) == 1
    d = depth([], initialized=(0,))  # active bin 35 sits in array 0
    assert new_bin_arrays(d, -10, 10) == 0
    assert new_bin_arrays(d, -40, 40) == 2  # needs arrays -1 and 1
    assert new_bin_arrays(d, -400, 0) is None  # beyond the scanned arrays
