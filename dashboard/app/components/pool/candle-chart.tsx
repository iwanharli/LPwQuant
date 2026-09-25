"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { bollinger, ema, rsi, supertrend, type Line } from "../../lib/indicators";
import type { Candle } from "../../lib/pool-detail-types";

export type IndicatorKey = "supertrend" | "ema20" | "ema50" | "bb" | "rsi";
export const INDICATORS: { key: IndicatorKey; label: string; color: string }[] = [
  { key: "supertrend", label: "SuperTrend 10 3", color: "#35d07f" },
  { key: "ema20", label: "EMA 20", color: "#f5f1e6" },
  { key: "ema50", label: "EMA 50", color: "#f7d774" },
  { key: "bb", label: "BB 20 2", color: "#5b9dff" },
  { key: "rsi", label: "RSI 2", color: "#a78bfa" },
];
const COLOR = Object.fromEntries(INDICATORS.map((i) => [i.key, i.color])) as Record<IndicatorKey, string>;
const ST_DOWN = "#e0525f";

/** The chart's time axis is UTC; shifting every timestamp by +7h makes its labels read as WIB. */
const WIB_OFFSET_S = 7 * 3600;

export type ChartLevel = { price: number; title: string; color: string; style: "solid" | "dashed" | "dotted" };
export type ChartMarker = { ts: number; position: "above" | "below"; color: string; text: string; shape: "up" | "down" };

function toTime(ms: number): UTCTimestamp {
  return (Math.floor(ms / 1000) + WIB_OFFSET_S) as UTCTimestamp;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** The chart draws on canvas, which cannot parse CSS color functions like color-mix(): pass rgba() instead. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Enough decimals for memecoin prices like 0.0000145 without drowning 1,000+ prices in zeros. */
function priceFormat(price: number) {
  const precision = price > 0 ? Math.min(12, Math.max(2, Math.ceil(-Math.log10(price)) + 4)) : 6;
  return { type: "price" as const, precision, minMove: 10 ** -precision };
}

const LINE_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted };

export default function CandleChart({
  candles,
  levels,
  markers,
  tfSeconds,
  livePrice,
  logScale = false,
  indicators,
  usdRate = null,
  quoteLabel,
}: {
  candles: Candle[];
  levels: ChartLevel[];
  markers: ChartMarker[];
  tfSeconds: number;
  livePrice: number | null;
  /** Logarithmic price axis: readable across 10x memecoin moves and never below zero. */
  logScale?: boolean;
  indicators: Record<IndicatorKey, boolean>;
  /** Multiply every price by this to show USD (null: prices in the quote token). */
  usdRate?: number | null;
  quoteLabel: string;
}) {
  const k = usdRate ?? 1;
  const data = useMemo(
    () => (k === 1 ? candles : candles.map((c) => ({ ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k }))),
    [candles, k],
  );
  const ind = useMemo(() => {
    const closes = data.map((c) => c.close);
    return { st: supertrend(data), ema20: ema(closes, 20), ema50: ema(closes, 50), bb: bollinger(closes), rsi: rsi(closes, 2) };
  }, [data]);
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const lineRefs = useRef<Partial<Record<string, ISeriesApi<"Line">>>>({});
  const extremesRef = useRef<IPriceLine[]>([]);
  const dataRef = useRef<Candle[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const fittedRef = useRef<string>("");

  useEffect(() => {
    if (!containerRef.current) return;
    const ink3 = cssVar("--color-ink-3", "#758397");
    const line = cssVar("--color-line", "#1f2a38");
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: ink3,
        fontFamily: "inherit",
        attributionLogo: true,
      },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
    });
    const up = cssVar("--color-up", "#35d07f");
    const down = cssVar("--color-down", "#ff6b78");
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
      // Prices are never negative: keep the autoscaled range (and its axis labels) at or above zero.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original();
        if (info?.priceRange) info.priceRange.minValue = Math.max(0, info.priceRange.minValue);
        return info;
      },
    });
    // Volume lives in its own pane below the price pane, so the price scale needs no bottom margin for it
    // (a shared margin pushed the axis below zero for low-priced tokens).
    volumeRef.current = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false },
      1,
    );
    chart.panes()[1]?.setHeight(110);
    volumeRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
    candleRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.06 } });
    markersRef.current = createSeriesMarkers(candleRef.current, []);
    const overlay = (color: string, width: 1 | 2 = 1, pane = 0) =>
      chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: true }, pane);
    lineRefs.current = {
      st: overlay(COLOR.supertrend, 2),
      ema20: overlay(COLOR.ema20),
      ema50: overlay(COLOR.ema50),
      bbUp: overlay(COLOR.bb),
      bbMid: overlay("#f59e5b"),
      bbLow: overlay(COLOR.bb),
      rsi: overlay(COLOR.rsi, 1, 2),
    };
    const rsiSeries = lineRefs.current.rsi!;
    rsiSeries.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    for (const level of [70, 30]) {
      rsiSeries.createPriceLine({ price: level, color: withAlpha("#a78bfa", 0.45), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    }
    chart.panes()[2]?.setHeight(90);
    chart.subscribeCrosshairMove((p: MouseEventParams) => {
      if (p.time == null) return setHover(null);
      const t = Number(p.time);
      const i = dataRef.current.findIndex((c) => toTime(c.ts) === t);
      setHover(i >= 0 ? i : null);
    });
    // High/Low of what is on screen, like Meteora's chart.
    const markExtremes = (range: LogicalRange | null) => {
      const series = candleRef.current;
      if (!series) return;
      for (const l of extremesRef.current) series.removePriceLine(l);
      extremesRef.current = [];
      const rows = dataRef.current;
      if (!range || !rows.length) return;
      const from = Math.max(0, Math.floor(range.from));
      const to = Math.min(rows.length - 1, Math.ceil(range.to));
      if (to < from) return;
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = from; i <= to; i++) {
        hi = Math.max(hi, rows[i].high);
        lo = Math.min(lo, rows[i].low);
      }
      const grey = cssVar("--color-ink-3", "#758397");
      extremesRef.current = [
        series.createPriceLine({ price: hi, color: grey, lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: true, title: "High" }),
        series.createPriceLine({ price: lo, color: grey, lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: true, title: "Low" }),
      ];
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(markExtremes);
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
      linesRef.current = [];
      lineRefs.current = {};
      extremesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const onChange = () => {
      setFull(document.fullscreenElement === wrapRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const r = lineRefs.current;
    const series = candleRef.current;
    if (!series || !r.st) return;
    const fmt = series.options().priceFormat;
    const put = (s: ISeriesApi<"Line"> | undefined, line: Line, on: boolean, color?: (i: number) => string) => {
      if (!s) return;
      s.applyOptions({ visible: on, ...(s === r.rsi ? {} : { priceFormat: fmt }) });
      s.setData(
        on
          ? data.flatMap((c, i) => (line[i] == null ? [] : [{ time: toTime(c.ts), value: line[i]!, ...(color ? { color: color(i) } : {}) }]))
          : [],
      );
    };
    put(r.st, ind.st.value, indicators.supertrend, (i) => (ind.st.up[i] ? COLOR.supertrend : ST_DOWN));
    put(r.ema20, ind.ema20, indicators.ema20);
    put(r.ema50, ind.ema50, indicators.ema50);
    put(r.bbUp, ind.bb.upper, indicators.bb);
    put(r.bbMid, ind.bb.mid, indicators.bb);
    put(r.bbLow, ind.bb.lower, indicators.bb);
    put(r.rsi, ind.rsi, indicators.rsi);
    chartRef.current?.panes()[2]?.setHeight(indicators.rsi ? 90 : 1);
  }, [data, ind, indicators]);

  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logScale]);

  useEffect(() => {
    const series = candleRef.current;
    const volume = volumeRef.current;
    if (!series || !volume) return;
    const up = cssVar("--color-up", "#35d07f");
    const down = cssVar("--color-down", "#ff6b78");
    dataRef.current = data;
    const last = data[data.length - 1];
    series.applyOptions({ priceFormat: priceFormat(last?.close ?? (livePrice ?? 1) * k) });
    series.setData(data.map((c) => ({ time: toTime(c.ts), open: c.open, high: c.high, low: c.low, close: c.close })));
    volume.setData(
      data.map((c) => ({
        time: toTime(c.ts),
        value: c.volume,
        color: withAlpha(c.close >= c.open ? up : down, 0.4),
      })),
    );
    // Fit once per dataset (timeframe/pool), not on every refresh, so a zoomed-in view stays put.
    const signature = `${tfSeconds}:${candles[0]?.ts ?? 0}`;
    if (candles.length && fittedRef.current !== signature) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = signature;
    }
  }, [data, candles, tfSeconds, livePrice, k]);

  useEffect(() => {
    // Live price moves the forming candle between candle refreshes.
    const series = candleRef.current;
    const last = data[data.length - 1];
    if (!series || !last || livePrice == null || !Number.isFinite(livePrice)) return;
    if (Date.now() - last.ts > tfSeconds * 1000) return;
    const live = livePrice * k;
    series.update({
      time: toTime(last.ts),
      open: last.open,
      high: Math.max(last.high, live),
      low: Math.min(last.low, live),
      close: live,
    });
  }, [livePrice, data, tfSeconds, k]);

  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const l of linesRef.current) series.removePriceLine(l);
    linesRef.current = levels
      .filter((l) => Number.isFinite(l.price) && l.price > 0)
      .map((l) =>
        series.createPriceLine({
          price: l.price * k,
          color: l.color,
          lineWidth: 1,
          lineStyle: LINE_STYLE[l.style],
          axisLabelVisible: true,
          title: l.title,
        }),
      );
  }, [levels, k]);

  useEffect(() => {
    if (!markersRef.current) return;
    const first = candles[0]?.ts ?? 0;
    const bucket = tfSeconds * 1000;
    const list: SeriesMarker<Time>[] = markers
      .filter((m) => m.ts >= first)
      .map((m) => ({
        time: toTime(Math.floor(m.ts / bucket) * bucket),
        position: m.position === "above" ? ("aboveBar" as const) : ("belowBar" as const),
        shape: m.shape === "up" ? ("arrowUp" as const) : ("arrowDown" as const),
        color: m.color,
        text: m.text,
      }))
      .sort((a, b) => Number(a.time) - Number(b.time));
    markersRef.current.setMarkers(list);
  }, [markers, candles, tfSeconds]);

  const i = hover ?? data.length - 1;
  const c = data[i];
  const prev = i > 0 ? data[i - 1] : null;
  const f = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : n.toPrecision(n >= 1 ? 6 : 4));
  const change = c && prev ? ((c.close - prev.close) / prev.close) * 100 : null;
  const ohlcTone = c && c.close >= c.open ? "text-up" : "text-down";
  const legend: { key: IndicatorKey; values: string[]; colors: string[] }[] = [
    { key: "supertrend", values: [f(ind.st.value[i])], colors: [ind.st.up[i] === false ? ST_DOWN : COLOR.supertrend] },
    { key: "ema20", values: [f(ind.ema20[i])], colors: [COLOR.ema20] },
    { key: "ema50", values: [f(ind.ema50[i])], colors: [COLOR.ema50] },
    { key: "bb", values: [f(ind.bb.mid[i]), f(ind.bb.upper[i]), f(ind.bb.lower[i])], colors: ["#f59e5b", COLOR.bb, COLOR.bb] },
    { key: "rsi", values: [ind.rsi[i] == null ? "–" : ind.rsi[i]!.toFixed(2)], colors: [COLOR.rsi] },
  ];

  return (
    <div ref={wrapRef} className={`relative w-full ${full ? "bg-bg p-3" : ""}`}>
      <div className="pointer-events-none absolute left-3 top-2 z-10 space-y-0.5 text-[11px] tabular-nums leading-5">
        {c && (
          <div className="flex flex-wrap gap-x-2">
            <span className="text-ink-3">{quoteLabel}</span>
            {(["open", "high", "low", "close"] as const).map((key) => (
              <span key={key} className="text-ink-3">
                {key[0].toUpperCase()}
                <span className={ohlcTone}>{f(c[key])}</span>
              </span>
            ))}
            {change != null && (
              <span className={ohlcTone}>
                {change >= 0 ? "+" : ""}
                {change.toFixed(2)}%
              </span>
            )}
          </div>
        )}
        {legend
          .filter((l) => indicators[l.key])
          .map((l) => (
            <div key={l.key} className="flex gap-2">
              <span className="text-ink-3">{INDICATORS.find((x) => x.key === l.key)?.label}</span>
              {l.values.map((v, j) => (
                <span key={j} style={{ color: l.colors[j] }}>
                  {v}
                </span>
              ))}
            </div>
          ))}
      </div>
      <button
        type="button"
        onClick={() => (full ? document.exitFullscreen() : wrapRef.current?.requestFullscreen())}
        title={full ? "Keluar layar penuh" : "Layar penuh"}
        className="absolute right-16 top-2 z-10 rounded-md border border-white/[0.08] bg-bg/80 px-2 py-1 text-xs text-ink-3 hover:text-ink"
      >
        {full ? "✕" : "⛶"}
      </button>
      <div ref={containerRef} className={full ? "h-[calc(100vh-24px)] w-full" : "h-[520px] w-full sm:h-[620px]"} />
    </div>
  );
}
