import math

from app.depth import (
    Depth,
    bin_array_index,
    depth_per_bin_y,
    fee_for_position_pct_day,
    fee_share,
    guarded_fee_share,
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
    # $1,000 fees/day (1% of $5k TVL x 20). $100 over 10 bins against $1,000/bin depth: per-bin share 1/101,
    # below the 10x TVL-share cap (10 x 100/5100), so it stands.
    pct = fee_for_position_pct_day(20.0, 5_000, 100, 10, 1_000.0)
    assert math.isclose(pct, 1_000 * (10 / 1_010) / 100 * 100)
    # Spreading the same $100 over 100 bins earns far less per dollar.
    assert fee_for_position_pct_day(20.0, 5_000, 100, 100, 1_000.0) < pct


def test_depth_share_is_boosted_but_capped_relative_to_tvl_share():
    tvl_share = 100 / (100_000 + 100)
    # Only $1k of a $100k pool near the price: the raw per-bin share is ~91x the TVL share, capped at 10x.
    assert fee_share(100 / 10, 1_000 / 10) > 50 * tvl_share
    capped = guarded_fee_share(10.0, 100.0, 5, 100.0, 100_000.0, None)
    assert math.isclose(capped, 10 * tvl_share)
    # A modest concentration (3x) passes through unchanged.
    modest = guarded_fee_share(10.0, 3_000.0, 5, 100.0, 100_000.0, None)
    assert math.isclose(modest, fee_share(10.0, 3_000.0))


def test_thin_liquidity_next_to_price_cannot_absorb_the_pool_volume():
    # The arc-USDC case: $3.5/bin near price, $66k TVL mostly elsewhere, $9.8k/h volume, $30 over 10 bins.
    raw = fee_share(3.0, 3.5)  # ~46% of all pool fees
    guarded = guarded_fee_share(3.0, 3.5, 2, 30.0, 66_420.0, 9_800.0)
    assert raw > 0.4
    assert guarded <= 10 * 30 / (66_420 + 30) + 1e-12  # the TVL cap binds
    turnover_only = guarded_fee_share(3.0, 3.5, 2, 30.0, 0.0, 9_800.0)  # no TVL cap: turnover bound alone
    assert math.isclose(turnover_only, raw * 24 * (6.5 * 5) / 9_800)


def test_new_bin_arrays_counts_missing_and_unknown():
    assert bin_array_index(-1) == -1 and bin_array_index(69) == 0 and bin_array_index(70) == 1
    d = depth([], initialized=(0,))  # active bin 35 sits in array 0
    assert new_bin_arrays(d, -10, 10) == 0
    assert new_bin_arrays(d, -40, 40) == 2  # needs arrays -1 and 1
    assert new_bin_arrays(d, -400, 0) is None  # beyond the scanned arrays
