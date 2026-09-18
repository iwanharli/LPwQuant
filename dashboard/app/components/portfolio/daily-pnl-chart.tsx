"use client";

import { ColorType, HistogramSeries, createChart, type Time } from "lightweight-charts";
import { useEffect, useRef } from "react";

export type DailyPnl = { day: string; pnl_usd: number; pnl_sol: number; value_usd: number; partial: boolean };

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Profit per WIB day as up/down bars. A day tracked only partly (the first one) is drawn faded. */
export default function DailyPnlChart({ days }: { days: DailyPnl[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || days.length === 0) return;
    const up = cssVar("--color-up", "#3fb68b");
    const down = cssVar("--color-down", "#e5534b");
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: cssVar("--color-ink-3", "#7d8594"),
        fontFamily: "inherit",
        fontSize: 11,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(38,45,56,0.6)" } },
      rightPriceScale: { borderVisible: false },
      // Fixed bar width: fitting one or two days to the full width draws a single slab, not a bar.
      timeScale: { borderVisible: false, barSpacing: 28, minBarSpacing: 6, fixLeftEdge: false, rightOffset: 2 },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      priceLineVisible: false,
    });
    series.setData(
      days.map((d) => {
        const color = d.pnl_usd >= 0 ? up : down;
        return { time: d.day as Time, value: d.pnl_usd, color: d.partial ? `${color}66` : color };
      }),
    );
    if (days.length > 30) chart.timeScale().fitContent();
    else chart.timeScale().scrollToRealTime();
    return () => chart.remove();
  }, [days]);

  return <div ref={ref} className="h-56 w-full" role="img" aria-label="Keuntungan per hari" />;
}
