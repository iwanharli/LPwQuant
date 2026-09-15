import math
import random

from dataclasses import replace

from app.backtest import FeeSeries, LpPosition, entry_flags_and_safety, lp_fee_fraction, simulate, summarize
from app.recommend import PlanParams, bins_below, bins_for_width, plan_position

HOUR = 3_600_000
PARAMS = PlanParams(portfolio_usd=1000, max_position_pct=5, hold_hours=4)


def _brute_value(pos: LpPosition, p: float) -> float:
    g = math.sqrt(pos.r)
    total = 0.0
    for i in range(-pos.a, pos.b + 1):
        p_i = pos.p0 * pos.r**i
        l_i = pos.v * (pos.r**i if i > 0 else 1.0)
        lower, upper = p_i / g, p_i * g
        if p >= upper:
            total += l_i
        elif p <= lower:
            total += l_i / p_i * p
        else:
            frac = (math.log(p) - math.log(lower)) / (math.log(upper) - math.log(lower))
            total += l_i * frac + l_i / p_i * (1 - frac) * p
    return total


def test_lp_value_matches_brute_force_and_entry_capital():
    pos = LpPosition.build(p0=2.5, bin_step=80, range_low_pct=-20, range_high_pct=15, capital=1000)
    assert math.isclose(pos.value(2.5), 1000, rel_tol=1e-9)
    rng = random.Random(7)
    for _ in range(200):
        p = 2.5 * math.exp(rng.uniform(-0.6, 0.6))
        assert math.isclose(pos.value(p), _brute_value(pos, p), rel_tol=1e-9)


def test_lp_underperforms_hodl_when_price_moves_either_way():
    pos = LpPosition.build(p0=1.0, bin_step=50, range_low_pct=-10, range_high_pct=10, capital=1000)
    for p in (0.8, 0.95, 1.05, 1.3):
        assert pos.value(p) < pos.hodl_value(p)
    # Far above range: everything sold to quote, value stops growing.
    assert math.isclose(pos.value(2.0), pos.value(3.0))


def test_bins_for_width():
    assert bins_for_width(0, 100) == 0
    assert bins_for_width(10, 100) == math.ceil(math.log(1.1) / math.log(1.01))


def test_bins_below_reach_the_full_downside():
    # Bin step 20, -20%: a rise-style formula gives 92 bins, which only reaches -16.8%.
    assert bins_for_width(20, 20) == 92
    assert bins_below(20, 20) == 112
    for step in (1, 20, 100, 250):
        for width in (2.0, 10.0, 20.0, 45.0, 60.0):
            reached = (1 + step / 10_000) ** -bins_below(width, step) - 1
            assert reached <= -width / 100 + 1e-12  # min price at or below the requested floor
            one_less = (1 + step / 10_000) ** -(bins_below(width, step) - 1) - 1
            assert one_less > -width / 100  # and no extra bin
    assert bins_below(0, 20) == 0


def test_plan_bins_cover_both_sides():
    plan = _plan(change_pct_1h=-7)  # bid-ask: range below price only
    assert plan["range_high_pct"] == 0
    assert plan["bins"] == bins_below(-plan["range_low_pct"], 100) + 1


def _plan(**overrides):
    kwargs = dict(
        bin_step=100, tvl=200_000, score=70, safety=30, flags=[],
        change_pct_1h=1.0, realized_vol_pct_1h=4.0, fee_for_position_pct_day=10.0, params=PARAMS,
    )
    kwargs.update(overrides)
    return plan_position(**kwargs)


def test_plan_avoid_wait_and_strategies():
    assert _plan(flags=["mint_authority"])["action"] == "avoid"
    assert _plan(change_pct_1h=-20)["action"] == "avoid"
    assert _plan(realized_vol_pct_1h=None)["action"] == "wait"

    down = _plan(change_pct_1h=-7)
    assert down["strategy"] == "bid_ask" and down["range_high_pct"] == 0

    calm = _plan(realized_vol_pct_1h=1.0)
    assert calm["strategy"] == "curve"

    sideways = _plan()
    assert sideways["action"] == "enter" and sideways["strategy"] == "spot"
    assert sideways["range_low_pct"] == -sideways["range_high_pct"]
    # Score ranks pools; it no longer gates entry.
    assert _plan(score=40)["action"] == "enter"
    assert _plan(flags=["mint_authority"])["tier"] is None


def test_plan_uses_market_regime_and_indicators():
    ranging_calm = {"regime": "ranging", "atr_pct": 1.0, "donchian_low_pct": -4.0, "donchian_high_pct": 3.0}
    plan = _plan(realized_vol_pct_1h=None, change_pct_1h=None, market=ranging_calm)
    assert plan["action"] == "enter" and plan["strategy"] == "curve" and plan["tier"] == "low"
    assert plan["exit"]["breakout_below_pct"] == -4.0
    assert plan["exit"]["breakout_above_pct"] == 3.0
    buffered = _plan(realized_vol_pct_1h=None, change_pct_1h=None, market=ranging_calm,
                     params=replace(PARAMS, breakout_buffer_pct=5.0))
    assert buffered["exit"]["breakout_below_pct"] == -9.0 and buffered["exit"]["breakout_above_pct"] == 8.0

    down = _plan(change_pct_1h=2.0, market={"regime": "trending_down", "atr_pct": 2.0, "rsi": 25})
    assert down["strategy"] == "bid_ask" and down["range_high_pct"] == 0
    assert any("RSI" in n for n in down["notes"])

    base = _plan(market={"regime": "mixed", "atr_pct": 2.0})
    squeezed = _plan(market={"regime": "mixed", "atr_pct": 2.0, "bb_squeeze": True})
    assert squeezed["range_high_pct"] > base["range_high_pct"]

    assert _plan(flags=["strong_downtrend", "sell_pressure"])["action"] == "avoid"


def test_plan_rule_parameters():
    assert _plan(change_pct_1h=45.0)["action"] == "avoid"
    no_pump_filter = replace(PARAMS, pump_threshold_pct=None)
    assert _plan(change_pct_1h=45.0, params=no_pump_filter)["action"] == "enter"

    channel = {"regime": "mixed", "atr_pct": 2.0, "donchian_low_pct": -4.0, "donchian_high_pct": 3.0}
    off = _plan(market=channel, params=replace(PARAMS, breakout_buffer_pct=None))
    assert off["exit"]["breakout_below_pct"] is None and off["exit"]["breakout_above_pct"] is None

    # No ATR cap by default: volatile pools land in a higher risk tier instead.
    assert _plan(market={"regime": "mixed", "atr_pct": 7.0})["tier"] == "high"
    capped = replace(PARAMS, max_atr_pct=5.0)
    assert _plan(market={"regime": "mixed", "atr_pct": 7.0}, params=capped)["action"] == "avoid"
    assert _plan(market={"regime": "mixed", "atr_pct": 4.0}, params=capped)["tier"] == "medium"

    wider_curve = replace(PARAMS, curve_max_atr_pct=3.0)
    assert _plan(market={"regime": "ranging", "atr_pct": 2.5}, params=wider_curve)["strategy"] == "curve"
    assert _plan(market={"regime": "ranging", "atr_pct": 2.5})["strategy"] == "spot"


def test_breakout_levels_ignore_channel_edges_too_close_to_entry():
    from app.recommend import breakout_levels

    assert breakout_levels(-4.7, 0.4, 1.0, 0.0) == (-4.7, None)  # +0.4% is noise
    assert breakout_levels(-4.7, 0.4, 5.0, 0.0) == (None, None)  # closer than 1 ATR on both sides
    assert breakout_levels(-1.5, 1.0, 0.5, 1.0) == (-2.5, 2.0)  # buffer can push a side past the minimum
    assert breakout_levels(-10.0, 10.0, 2.0, None) == (None, None)  # breakout exit disabled
    plan = _plan(market={"regime": "mixed", "atr_pct": 1.0, "donchian_low_pct": -4.7, "donchian_high_pct": 0.4})
    assert plan["exit"]["breakout_above_pct"] is None and plan["exit"]["breakout_below_pct"] == -4.7


def test_breakout_side_dropped_when_price_already_outside_channel():
    # New high: the prior channel high sits 12% below the current price.
    above_channel = {"regime": "trending_up", "atr_pct": 2.0, "donchian_low_pct": -38.0, "donchian_high_pct": -12.1}
    plan = _plan(market=above_channel)
    assert plan["exit"]["breakout_above_pct"] is None
    assert plan["exit"]["breakout_below_pct"] == -38.0

    below_channel = {"regime": "trending_down", "atr_pct": 2.0, "donchian_low_pct": 4.0, "donchian_high_pct": 20.0}
    plan = _plan(market=below_channel)
    assert plan["exit"]["breakout_below_pct"] is None and plan["exit"]["breakout_above_pct"] == 20.0

    # Simulation must not exit on the very first step because of a stale level.
    series = [(i * 60_000, 1.0 + 0.001 * i) for i in range(30)]
    trade = simulate(series, 0, lambda ts: (0.001, 100_000.0), 50, 100, _plan(market=above_channel))
    assert trade["exit_reason"] != "breakout"


def test_lp_fee_fraction_uses_observed_net_fees():
    # SOL-USDC style: base 0.04%, LP received 0.0387% of volume (protocol cut > tiny dynamic fee).
    assert math.isclose(lp_fee_fraction(38.7, 100_000, 0.04), 0.000387)  # below base fee is allowed now
    assert math.isclose(lp_fee_fraction(3_000, 100_000, 0.1), 0.03)  # dynamic fee spike
    assert lp_fee_fraction(50_000, 100_000, 0.1) == 0.10  # capped
    assert math.isclose(lp_fee_fraction(None, 0, 1.0), 0.009)  # no data: base fee x 90% LP share
    assert math.isclose(lp_fee_fraction(5, 500, 1.0), 0.009)  # too little volume to trust


def test_fee_series_uses_nearest_snapshot_within_gap():
    series = FeeSeries(ts=[0, 60 * 60_000, 120 * 60_000], fractions=[0.001, 0.02, 0.003], fallback=0.005)
    assert series.at(55 * 60_000) == 0.02  # nearest is the 60-minute snapshot
    assert series.at(125 * 60_000) == 0.003
    assert series.at(10 * 60 * 60_000) == 0.005  # far from any snapshot: pool fallback
    assert FeeSeries([], [], 0.004).at(0) == 0.004


def test_entry_flags_rebuild_market_part():

    # Stored flags came from a later moment; market flags are replaced by those at entry.
    flags, safety = entry_flags_and_safety(
        ["unverified", "dumping", "sideways"], 20.0, {"regime": "trending_up", "atr_pct": 9.0}, 35.0
    )
    assert set(flags) == {"unverified", "pumping", "uptrend", "extreme_volatility"}
    assert safety == 20.0 + 10 - 10 - 5


def test_plan_size_scales_with_tier_safety_and_tvl_cap():
    low = _plan(realized_vol_pct_1h=2.0)  # vol 1.4% -> low tier
    assert low["tier"] == "low" and low["size_usd"] == 50  # 5% of 1000
    medium = _plan()  # rv 4% -> vol 2.8% -> medium tier
    assert medium["tier"] == "medium" and medium["size_usd"] == 30  # 60% of 5%
    assert _plan(safety=15)["size_usd"] == 15  # medium, half safety
    high = _plan(realized_vol_pct_1h=10.0)
    assert high["tier"] == "high" and high["size_usd"] == 15  # 30% of 5%
    capped = _plan(tvl=500)
    assert capped["tier"] == "high" and capped["size_capped_by_tvl"] and capped["size_usd"] == 10


def test_simulate_stop_loss_on_crash():
    plan = _plan()
    series = [(i * 60_000, 1.0 * (0.97**i)) for i in range(60)]
    trade = simulate(series, 0, lambda ts: (0.001, 100_000.0), 50, 100, plan)
    assert trade["exit_reason"] in ("stop_loss", "out_of_range")
    assert trade["return_pct"] < 0


def test_simulate_flat_price_earns_fees():
    plan = _plan()
    series = [(i * 60_000, 1.0) for i in range(0, 121)]
    trade = simulate(series, 0, lambda ts: (0.01, 100_000.0), 50, 100, plan)
    assert trade["fee_pct"] > 0 and trade["return_pct"] > 0
    assert summarize([trade])["win_rate_pct"] == 100
