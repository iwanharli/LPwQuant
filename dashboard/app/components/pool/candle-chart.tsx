"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle } from "../../lib/pool-detail-types";

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
}: {
  candles: Candle[];
  levels: ChartLevel[];
  markers: ChartMarker[];
  tfSeconds: number;
  livePrice: number | null;
  /** Logarithmic price axis: readable across 10x memecoin moves and never below zero. */
  logScale?: boolean;
}) {
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
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
      linesRef.current = [];
    };
  }, []);

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
    const last = candles[candles.length - 1];
    series.applyOptions({ priceFormat: priceFormat(last?.close ?? livePrice ?? 1) });
    series.setData(candles.map((c) => ({ time: toTime(c.ts), open: c.open, high: c.high, low: c.low, close: c.close })));
    volume.setData(
      candles.map((c) => ({
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
  }, [candles, tfSeconds, livePrice]);

  useEffect(() => {
    // Live price moves the forming candle between candle refreshes.
    const series = candleRef.current;
    const last = candles[candles.length - 1];
    if (!series || !last || livePrice == null || !Number.isFinite(livePrice)) return;
    if (Date.now() - last.ts > tfSeconds * 1000) return;
    series.update({
      time: toTime(last.ts),
      open: last.open,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
      close: livePrice,
    });
  }, [livePrice, candles, tfSeconds]);

  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const l of linesRef.current) series.removePriceLine(l);
    linesRef.current = levels
      .filter((l) => Number.isFinite(l.price) && l.price > 0)
      .map((l) =>
        series.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: 1,
          lineStyle: LINE_STYLE[l.style],
          axisLabelVisible: true,
          title: l.title,
        }),
      );
  }, [levels]);

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

  return <div ref={containerRef} className="h-[460px] w-full sm:h-[540px]" />;
}
