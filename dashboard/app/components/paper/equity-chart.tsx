"use client";

import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtSignedPct, usd } from "../../lib/format";
import type { EquityPoint } from "../../lib/paper-types";

export type EquitySeries = { key: string; label: string; color: string; points: EquityPoint[] };

/** The chart's time axis is UTC; shifting every timestamp by +7h makes its labels read as WIB. */
const WIB_OFFSET_S = 7 * 3600;

function toTime(ms: number): UTCTimestamp {
  return (Math.floor(ms / 1000) + WIB_OFFSET_S) as UTCTimestamp;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** The chart draws on canvas, which cannot parse CSS color functions: pass rgba() instead. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Points in chart time, one per second at most: the library rejects repeated or unordered times. */
function toData(points: EquityPoint[]) {
  const bySecond = new Map<number, number>();
  for (const p of points) bySecond.set(toTime(p.ts), p.equity_usd);
  return [...bySecond.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as Time, value }));
}

/** Equity of every risk profile on one chart (lightweight-charts): thin curved lines, a soft area under the
 * selected profile, a dashed starting-capital line, and the legend cards above reading the hovered time. */
export default function EquityChart({
  series,
  start,
  selected,
}: {
  series: EquitySeries[];
  start: number;
  selected?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<"Line"> | ISeriesApi<"Area">>>(new Map());
  const [hovered, setHovered] = useState<Map<string, number> | null>(null);
  // Memoised: hovering re-renders this component, and a fresh array would re-add every series on each mouse move.
  const drawable = useMemo(() => series.filter((s) => s.points.length >= 2), [series]);
  const fitted = useRef(false);
  const hasData = drawable.length > 0;

  // One chart for the component's lifetime; series are swapped in the effect below.
  useEffect(() => {
    if (!containerRef.current || !hasData) return;
    const ink3 = cssVar("--color-ink-3", "#7d8594");
    const line = cssVar("--color-line", "#262d38");
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: ink3,
        fontFamily: "inherit",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: withAlpha(line.startsWith("#") ? line : "#262d38", 0.6), style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: ink3, width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#1d232c" },
        horzLine: { color: ink3, width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#1d232c" },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    chartRef.current = chart;

    const onMove = (param: MouseEventParams) => {
      if (!param.time || !param.point) {
        setHovered(null);
        return;
      }
      const values = new Map<string, number>();
      for (const [key, s] of seriesRef.current) {
        const d = param.seriesData.get(s) as { value?: number } | undefined;
        if (d?.value != null) values.set(key, d.value);
      }
      setHovered(values.size ? values : null);
    };
    chart.subscribeCrosshairMove(onMove);
    const seriesMap = seriesRef.current;
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesMap.clear();
      fitted.current = false;
    };
  }, [hasData]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of seriesRef.current.values()) chart.removeSeries(s);
    seriesRef.current.clear();

    const ink3 = cssVar("--color-ink-3", "#7d8594");
    // Selected profile last, so it draws on top of the others.
    const ordered = [...drawable].sort((a, b) => Number(a.key === selected) - Number(b.key === selected));
    ordered.forEach((s, i) => {
      const active = s.key === selected;
      const common = {
        lineWidth: (active ? 2 : 1) as 1 | 2,
        lineType: LineType.Curved,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerRadius: 3,
        crosshairMarkerBorderWidth: 1,
        title: s.label,
        priceFormat: { type: "price" as const, precision: 2, minMove: 0.01 },
      };
      const api = active
        ? chart.addSeries(AreaSeries, {
            ...common,
            lineColor: s.color,
            topColor: withAlpha(s.color, 0.22),
            bottomColor: withAlpha(s.color, 0),
          })
        : chart.addSeries(LineSeries, { ...common, color: selected ? withAlpha(s.color, 0.55) : s.color });
      api.setData(toData(s.points));
      if (i === 0) {
        api.createPriceLine({
          price: start,
          color: ink3,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Modal awal",
        });
      }
      seriesRef.current.set(s.key, api);
    });
    // Fit once: refitting on every new point (each minute) would throw away the reader's zoom.
    if (!fitted.current) {
      chart.timeScale().fitContent();
      fitted.current = true;
    }
  }, [drawable, selected, start]);

  if (!hasData) {
    return (
      <div className="grid h-72 place-items-center rounded-lg border border-line bg-bg/35 text-sm text-ink-3">
        <div className="text-center">
          <div className="text-base font-medium text-ink">Menunggu titik equity</div>
          <div className="mt-1">Kurva muncul setelah beberapa siklus engine (sekitar 1 menit per titik).</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-bg/35">
      <div className="grid grid-cols-1 gap-2 border-b border-line px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Highest PnL on the left, by the latest point rather than the hovered one, so the cards do not jump
            around while the crosshair moves. */}
        {[...series]
          .sort(
            (a, b) =>
              (b.points[b.points.length - 1]?.equity_usd ?? start) - (a.points[a.points.length - 1]?.equity_usd ?? start),
          )
          .map((s) => {
          const last = s.points[s.points.length - 1] ?? null;
          // While the crosshair is over the chart, the cards read the hovered time instead of the latest point.
          const equity = hovered?.get(s.key) ?? last?.equity_usd ?? start;
          const pnl = equity - start;
          const pct = start > 0 ? (pnl / start) * 100 : 0;
          const active = s.key === selected;
          return (
            <div
              key={s.key}
              className={`rounded-md border px-3 py-2 ${active ? "border-line-strong bg-raised/60" : "border-line bg-panel/60"}`}
            >
              <div className="flex items-center gap-2 text-xs text-ink-2">
                <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} aria-hidden />
                {s.label}
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-3 tabular-nums">
                <span className="text-lg font-semibold text-ink">{usd.format(equity)}</span>
                <span className={`text-xs font-medium ${pnl >= 0 ? "text-up" : "text-down"}`}>
                  {pnl >= 0 ? "+" : ""}
                  {usd.format(pnl)} · {fmtSignedPct(pct, 2)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div
        ref={containerRef}
        className="h-80 w-full"
        role="img"
        aria-label={`Equity per profil: ${series
          .map((s) => `${s.label} ${usd.format(s.points[s.points.length - 1]?.equity_usd ?? start)}`)
          .join(", ")}`}
      />
    </div>
  );
}
