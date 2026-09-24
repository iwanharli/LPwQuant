"""Technical indicators on OHLCV candles, chosen for LP decisions.

- Range width: ATR, Bollinger width (+ squeeze)
- Trend vs chop: ADX (+DI/-DI), Choppiness Index, EMA slope -> regime
- Stretch / exits: RSI, Donchian channel, drawdown from recent high
- Flow: buy/sell and buyer/seller ratios from transaction counts

Inputs are oldest-first; functions return the value at the latest candle, or None without enough data.
"""

import math
from dataclasses import dataclass
from statistics import fmean, median, pstdev
from typing import Any, Sequence

CANDLES_PER_HOUR = 2  # 30m timeframe
MIN_CANDLES = 15


@dataclass(frozen=True)
class Candle:
    ts: int  # open time, ms
    open: float
    high: float
    low: float
    close: float
    volume: float


def _rma(values: Sequence[float], n: int) -> list[float]:
    """Wilder smoothing seeded with an SMA; element i corresponds to values[n - 1 + i]."""
    if len(values) < n:
        return []
    out = [fmean(values[:n])]
    for v in values[n:]:
        out.append(out[-1] + (v - out[-1]) / n)
    return out


def ema(values: Sequence[float], n: int) -> list[float]:
    if len(values) < n:
        return []
    alpha = 2 / (n + 1)
    out = [fmean(values[:n])]
    for v in values[n:]:
        out.append(out[-1] + alpha * (v - out[-1]))
    return out


def true_ranges(candles: Sequence[Candle]) -> list[float]:
    out = []
    for i, c in enumerate(candles):
        if i == 0:
            out.append(c.high - c.low)
        else:
            prev_close = candles[i - 1].close
            out.append(max(c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close)))
    return out


def atr_pct(candles: Sequence[Candle], n: int = 14) -> float | None:
    if len(candles) < n + 1 or candles[-1].close <= 0:
        return None
    atr = _rma(true_ranges(candles)[1:], n)
    return atr[-1] / candles[-1].close * 100


def adx(candles: Sequence[Candle], n: int = 14) -> tuple[float, float, float] | None:
    """(ADX, +DI, -DI)"""
    if len(candles) < 2 * n + 1:
        return None
    plus_dm, minus_dm, trs = [], [], []
    for prev, cur in zip(candles, candles[1:]):
        up, down = cur.high - prev.high, prev.low - cur.low
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
        trs.append(max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close)))
    dx, plus_di, minus_di = [], 0.0, 0.0
    for tr, p, m in zip(_rma(trs, n), _rma(plus_dm, n), _rma(minus_dm, n)):
        plus_di = 100 * p / tr if tr > 0 else 0.0
        minus_di = 100 * m / tr if tr > 0 else 0.0
        total = plus_di + minus_di
        dx.append(100 * abs(plus_di - minus_di) / total if total > 0 else 0.0)
    smoothed = _rma(dx, n)
    return (smoothed[-1], plus_di, minus_di) if smoothed else None


def rsi(closes: Sequence[float], n: int = 14) -> float | None:
    if len(closes) < n + 1:
        return None
    gains = [max(b - a, 0.0) for a, b in zip(closes, closes[1:])]
    losses = [max(a - b, 0.0) for a, b in zip(closes, closes[1:])]
    avg_gain, avg_loss = _rma(gains, n)[-1], _rma(losses, n)[-1]
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    return 100 - 100 / (1 + avg_gain / avg_loss)


def bollinger(closes: Sequence[float], n: int = 20, k: float = 2.0) -> dict[str, float] | None:
    if len(closes) < n:
        return None
    window = closes[-n:]
    mid, sd = fmean(window), pstdev(window)
    upper, lower = mid + k * sd, mid - k * sd
    return {
        "width_pct": (upper - lower) / mid * 100 if mid > 0 else 0.0,
        "pct_b": (closes[-1] - lower) / (upper - lower) if upper > lower else 0.5,
    }


def supertrend(candles: Sequence[Candle], n: int = 10, mult: float = 3.0) -> dict[str, Any] | None:
    """Supertrend, the Panda entry trigger: the ATR band the price rides. `up` is True while the close is above the
    line, and `flipped_up` marks the candle where that just became true -- the "break" the strategy waits for."""
    atr = _rma(true_ranges(candles), n)  # atr[j] belongs to candles[n - 1 + j]
    if len(atr) < 3:
        return None
    up, line, flipped_up = True, 0.0, False
    for j, a in enumerate(atr):
        c = candles[n - 1 + j]
        mid = (c.high + c.low) / 2
        upper, lower = mid + mult * a, mid - mult * a
        if j == 0:
            up, line = c.close >= mid, (lower if c.close >= mid else upper)
            continue
        was_up = up
        if up:
            line = max(lower, line)  # the band only tightens while the trend holds
            if c.close < line:
                up, line = False, upper
        else:
            line = min(upper, line)
            if c.close > line:
                up, line = True, lower
        flipped_up = up and not was_up
    return {"line": line, "up": up, "flipped_up": flipped_up}


def macd_histogram(closes: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9) -> list[float] | None:
    """MACD histogram series; the Panda exit looks for its first green (positive) bar after red ones."""
    if len(closes) < slow + signal:
        return None
    fast_ema, slow_ema = ema(closes, fast), ema(closes, slow)
    macd = [f - s for f, s in zip(fast_ema, slow_ema)]
    sig = ema(macd, signal)
    return [m - s for m, s in zip(macd, sig)]


def bollinger_bands(closes: Sequence[float], n: int = 20, k: float = 2.0) -> dict[str, float] | None:
    """Absolute band prices, for rules that compare the close with the upper band."""
    if len(closes) < n:
        return None
    window = closes[-n:]
    mid, sd = fmean(window), pstdev(window)
    return {"mid": mid, "upper": mid + k * sd, "lower": mid - k * sd}


def bollinger_squeeze(closes: Sequence[float], n: int = 20, lookback: int = 60, quantile: float = 0.2) -> bool | None:
    """Current band width in the lowest `quantile` of widths over the lookback (and below their median,
    so a steady width never counts as a squeeze)."""
    if len(closes) < n + 10:
        return None
    widths = []
    for end in range(max(n, len(closes) - lookback), len(closes) + 1):
        window = closes[end - n : end]
        mid = fmean(window)
        widths.append(pstdev(window) / mid if mid > 0 else 0.0)
    ranked = sorted(widths)
    current = widths[-1]
    return current <= ranked[max(0, math.ceil(len(ranked) * quantile) - 1)] and current < median(widths)


def choppiness(candles: Sequence[Candle], n: int = 14) -> float | None:
    """100 = pure chop (sideways), 0 = straight trend. Above ~61.8 is commonly read as ranging."""
    if len(candles) < n + 1:
        return None
    window = candles[-n:]
    high, low = max(c.high for c in window), min(c.low for c in window)
    if high <= low:
        return None
    return 100 * math.log10(sum(true_ranges(candles)[-n:]) / (high - low)) / math.log10(n)


def ema_slope_pct(closes: Sequence[float], n: int = 20, lookback: int = 3) -> float | None:
    series = ema(closes, n)
    if len(series) <= lookback or series[-1 - lookback] <= 0:
        return None
    return (series[-1] / series[-1 - lookback] - 1) * 100


def donchian(candles: Sequence[Candle], n: int = 20) -> tuple[float, float] | None:
    """(lowest low, highest high) of the n candles before the latest one."""
    if len(candles) < n + 1:
        return None
    prior = candles[-n - 1 : -1]
    return min(c.low for c in prior), max(c.high for c in prior)


def change_pct(closes: Sequence[float], periods: int) -> float | None:
    if len(closes) <= periods or closes[-1 - periods] <= 0:
        return None
    return (closes[-1] / closes[-1 - periods] - 1) * 100


def drawdown_pct(candles: Sequence[Candle], n: int) -> float | None:
    window = candles[-n:]
    high = max((c.high for c in window), default=0.0)
    return (candles[-1].close / high - 1) * 100 if high > 0 else None


def classify_regime(adx_value: float | None, plus_di: float | None, minus_di: float | None, chop: float | None) -> str | None:
    """Strong ADX = trend. Ranging needs choppy price action too: a low ADX alone (e.g. a slow,
    steady drift with low Choppiness) is not treated as sideways."""
    if adx_value is None or plus_di is None or minus_di is None:
        return None
    if adx_value >= 25:
        return "trending_up" if plus_di >= minus_di else "trending_down"
    if chop is not None and (chop >= 61.8 or (adx_value < 20 and chop >= 45)):
        return "ranging"
    return "mixed"


REVERSAL_WINDOW = 48  # 24h of 30m candles


def reversal_rate(closes: Sequence[float], window: int = REVERSAL_WINDOW) -> float | None:
    """Share of consecutive candle moves that change direction over the last `window` candles: about 0.5 for a
    random walk, below it when moves keep going the same way (a trend), above it when price keeps turning back.
    Flat candles are skipped. On 30 days of backtested LP trades it sorted results cleanly: below 0.40 averaged
    -3.35% per trade, at 0.60 and above +0.86%, with IL falling from -4.4% to -0.1% while fees held steady."""
    tail = list(closes[-window:])
    moves = [tail[k] / tail[k - 1] - 1 for k in range(1, len(tail)) if tail[k - 1] > 0]
    moves = [m for m in moves if m != 0]
    if len(moves) < 10:
        return None
    return sum(1 for k in range(1, len(moves)) if moves[k] * moves[k - 1] < 0) / (len(moves) - 1)


def compute_indicators(candles: Sequence[Candle]) -> dict[str, Any] | None:
    if len(candles) < MIN_CANDLES:
        return None
    closes = [c.close for c in candles]
    last = closes[-1]
    adx_result = adx(candles)
    adx_value, plus_di, minus_di = adx_result if adx_result else (None, None, None)
    chop = choppiness(candles)
    bands = bollinger(closes)
    channel = donchian(candles)
    return {
        "candles": len(candles),
        "last_ts": candles[-1].ts,
        "atr_pct": atr_pct(candles),
        "adx": adx_value,
        "plus_di": plus_di,
        "minus_di": minus_di,
        "choppiness": chop,
        "rsi": rsi(closes),
        "bb_width_pct": bands["width_pct"] if bands else None,
        "bb_pct_b": bands["pct_b"] if bands else None,
        "bb_squeeze": bollinger_squeeze(closes),
        "ema_slope_pct": ema_slope_pct(closes),
        "donchian_low_pct": (channel[0] / last - 1) * 100 if channel and last > 0 else None,
        "donchian_high_pct": (channel[1] / last - 1) * 100 if channel and last > 0 else None,
        "change_1h_pct": change_pct(closes, CANDLES_PER_HOUR),
        "change_24h_pct": change_pct(closes, 24 * CANDLES_PER_HOUR),
        "reversal_rate": reversal_rate(closes),
        "drawdown_pct": drawdown_pct(candles, 24 * CANDLES_PER_HOUR),
        "regime": classify_regime(adx_value, plus_di, minus_di, chop),
    }


def flow_features(flow: dict[str, Any] | None) -> dict[str, Any] | None:
    """Buy/sell pressure from transaction counts (already oriented to the pool's base token)."""
    if not flow:
        return None
    windows = flow.get("windows") or {}

    def ratio(window: str, a: str, b: str) -> float | None:
        w = windows.get(window) or {}
        total = (w.get(a) or 0) + (w.get(b) or 0)
        return (w.get(a) or 0) / total if total > 0 else None

    h1 = windows.get("h1") or {}
    txns = (h1.get("buys") or 0) + (h1.get("sells") or 0)
    buy_ratio = ratio("h1", "buys", "sells")
    buyer_ratio = ratio("h1", "buyers", "sellers")
    return {
        "flow_ts": flow.get("ts"),
        "txns_h1": txns,
        "buy_ratio_h1": buy_ratio,
        "buyer_ratio_h1": buyer_ratio,
        "buy_ratio_m15": ratio("m15", "buys", "sells"),
        "sell_pressure": txns >= 40
        and buy_ratio is not None
        and buy_ratio < 0.4
        and (buyer_ratio is None or buyer_ratio < 0.45),
    }


def merge_market(indicators: dict[str, Any] | None, flow: dict[str, Any] | None) -> dict[str, Any] | None:
    if not indicators and not flow:
        return None
    return {**(indicators or {}), **(flow or {})}
