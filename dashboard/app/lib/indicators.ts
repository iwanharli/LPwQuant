import type { Candle } from "./pool-detail-types";

/** One value per candle; null until the indicator has enough history. */
export type Line = (number | null)[];

export function ema(values: number[], period: number): Line {
  const out: Line = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let sum = 0;
  values.forEach((v, i) => {
    if (i < period - 1) {
      sum += v;
      out.push(null);
    } else if (prev == null) {
      prev = (sum + v) / period; // seeded with the simple average, like TradingView
      out.push(prev);
    } else {
      prev = v * k + prev * (1 - k);
      out.push(prev);
    }
  });
  return out;
}

export function bollinger(values: number[], period = 20, mult = 2): { mid: Line; upper: Line; lower: Line } {
  const mid: Line = [];
  const upper: Line = [];
  const lower: Line = [];
  values.forEach((_, i) => {
    if (i < period - 1) {
      mid.push(null);
      upper.push(null);
      lower.push(null);
      return;
    }
    const win = values.slice(i - period + 1, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / period);
    mid.push(m);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  });
  return { mid, upper, lower };
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 2): Line {
  const out: Line = [null];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= period) {
      gain += g / period;
      loss += l / period;
      out.push(i === period ? (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)) : null);
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
    }
  }
  return out;
}

/** SuperTrend on Wilder's ATR: the line under price while the trend is up, over it while down. */
export function supertrend(candles: Candle[], period = 10, mult = 3): { value: Line; up: (boolean | null)[] } {
  const value: Line = [];
  const up: (boolean | null)[] = [];
  let atr: number | null = null;
  let trSum = 0;
  let upperBand = 0;
  let lowerBand = 0;
  let trendUp = true;
  let started = false;
  candles.forEach((c, i) => {
    const prevClose = i ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    if (i < period) {
      trSum += tr;
      if (i === period - 1) atr = trSum / period;
    } else if (atr != null) {
      atr = (atr * (period - 1) + tr) / period;
    }
    if (atr == null) {
      value.push(null);
      up.push(null);
      return;
    }
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + mult * atr;
    const basicLower = hl2 - mult * atr;
    const first = !started;
    started = true;
    upperBand = first || basicUpper < upperBand || prevClose > upperBand ? basicUpper : upperBand;
    lowerBand = first || basicLower > lowerBand || prevClose < lowerBand ? basicLower : lowerBand;
    if (!first) {
      if (trendUp && c.close < lowerBand) trendUp = false;
      else if (!trendUp && c.close > upperBand) trendUp = true;
    }
    value.push(trendUp ? lowerBand : upperBand);
    up.push(trendUp);
  });
  return { value, up };
}
