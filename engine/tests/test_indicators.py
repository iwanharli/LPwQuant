import math

from app.indicators import (
    Candle,
    adx,
    atr_pct,
    bollinger,
    bollinger_squeeze,
    choppiness,
    classify_regime,
    compute_indicators,
    donchian,
    flow_features,
    rsi,
)

STEP_MS = 30 * 60_000


def uptrend(n: int, step: float = 1.0, start: float = 100.0) -> list[Candle]:
    """Each candle opens at the previous close and closes one step higher (TR = step)."""
    return [
        Candle(i * STEP_MS, start + i * step, start + (i + 1) * step, start + i * step, start + (i + 1) * step, 1.0)
        for i in range(n)
    ]


def sideways(n: int) -> list[Candle]:
    """Every candle spans the same 100-101 band."""
    return [Candle(i * STEP_MS, 100.0, 101.0, 100.0, 100.0 if i % 2 else 101.0, 1.0) for i in range(n)]


def test_trend_indicators_on_straight_uptrend():
    candles = uptrend(60)
    adx_value, plus_di, minus_di = adx(candles)
    assert math.isclose(adx_value, 100) and plus_di > minus_di == 0
    assert math.isclose(choppiness(candles), 0, abs_tol=1e-9)
    assert rsi([c.close for c in candles]) == 100
    assert math.isclose(atr_pct(candles), 1 / candles[-1].close * 100)
    assert classify_regime(adx_value, plus_di, minus_di, 0) == "trending_up"


def test_trend_indicators_on_sideways_band():
    candles = sideways(60)
    adx_value, plus_di, minus_di = adx(candles)
    assert adx_value == 0 and plus_di == minus_di == 0
    assert math.isclose(choppiness(candles), 100)
    assert classify_regime(adx_value, plus_di, minus_di, 100) == "ranging"


def test_regime_downtrend_and_mixed():
    assert classify_regime(30, 10, 40, 30) == "trending_down"
    assert classify_regime(22, 20, 18, 50) == "mixed"
    assert classify_regime(22, 20, 18, 65) == "ranging"
    # Low ADX but a steady drift (low Choppiness) is not sideways.
    assert classify_regime(18, 15, 43, 33) == "mixed"
    assert classify_regime(18, 15, 20, 50) == "ranging"
    assert classify_regime(None, None, None, None) is None


def test_bollinger_and_squeeze():
    flat = bollinger([5.0] * 20)
    assert flat["width_pct"] == 0 and flat["pct_b"] == 0.5
    wide_then_tight = [100 + (10 if i % 2 else -10) for i in range(50)] + [100.0] * 20
    assert bollinger_squeeze(wide_then_tight) is True
    assert bollinger_squeeze([100 + (10 if i % 2 else -10) for i in range(70)]) is False


def test_donchian_excludes_latest_candle():
    candles = uptrend(30)
    low, high = donchian(candles, 20)
    assert high == candles[-2].high and high < candles[-1].high
    assert low == candles[-21].low


def test_compute_indicators_requires_history_and_reports_regime():
    assert compute_indicators(uptrend(10)) is None
    ind = compute_indicators(uptrend(100))
    assert ind["regime"] == "trending_up"
    assert ind["candles"] == 100
    assert ind["change_1h_pct"] > 0 and ind["drawdown_pct"] == 0


def test_flow_features_sell_pressure():
    selling = {"ts": 1, "windows": {"h1": {"buys": 20, "sells": 60, "buyers": 10, "sellers": 30}}}
    features = flow_features(selling)
    assert features["txns_h1"] == 80 and math.isclose(features["buy_ratio_h1"], 0.25)
    assert features["sell_pressure"] is True
    quiet = {"ts": 1, "windows": {"h1": {"buys": 2, "sells": 10, "buyers": 1, "sellers": 5}}}
    assert flow_features(quiet)["sell_pressure"] is False
    assert flow_features(None) is None


def test_reversal_rate_separates_trends_from_oscillation():
    from app.indicators import reversal_rate

    zigzag = [100 + (1 if i % 2 else -1) for i in range(48)]          # turns back every candle
    trend = [100 * 1.01 ** i for i in range(48)]                       # never turns back
    assert reversal_rate(zigzag) == 1.0
    assert reversal_rate(trend) == 0.0
    assert reversal_rate([100.0] * 48) is None                         # flat: nothing to measure
    assert reversal_rate(zigzag[:8]) is None                           # too few moves
