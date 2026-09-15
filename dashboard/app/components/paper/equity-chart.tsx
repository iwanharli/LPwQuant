"use client";

import { useId, useMemo, useState, type MouseEvent } from "react";
import { fmtDateTime, fmtSignedPct, usd } from "../../lib/format";
import type { EquityPoint } from "../../lib/paper-types";

const W = 1000;
const H = 320;
const PAD = { left: 76, right: 26, top: 34, bottom: 42 };

function smoothPath(points: { x: number; y: number }[]) {
  if (points.length === 0) return "";
  if (points.length < 3) return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");

  const d = [`M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d.push(
      `C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`,
    );
  }
  return d.join("");
}

/** Single-series equity line: recessive grid, dashed starting-capital baseline, crosshair + tooltip on hover. */
export default function EquityChart({ points, start }: { points: EquityPoint[]; start: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].ts;
    const t1 = points[points.length - 1].ts;
    const values = points.map((p) => p.equity_usd).concat(start);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max - min < 0.01) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
    const x = (t: number) => PAD.left + ((t - t0) / Math.max(t1 - t0, 1)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);
    const plot = points.map((p) => ({ x: x(p.ts), y: y(p.equity_usd) }));
    const xs = plot.map((p) => p.x);
    const path = smoothPath(plot);
    const area = `${path}L${plot[plot.length - 1].x.toFixed(1)},${(H - PAD.bottom).toFixed(1)}L${plot[0].x.toFixed(1)},${(H - PAD.bottom).toFixed(1)}Z`;
    const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4).reverse();
    const timeTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + (t1 - t0) * f);
    return { x, y, xs, plot, path, area, ticks, timeTicks, min, max };
  }, [points, start]);

  if (!geo) {
    return (
      <div className="grid h-72 place-items-center rounded-lg border border-line bg-bg/35 text-sm text-ink-3">
        <div className="text-center">
          <div className="text-base font-medium text-ink">Menunggu titik equity</div>
          <div className="mt-1">Kurva muncul setelah beberapa siklus engine.</div>
        </div>
      </div>
    );
  }

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let lo = 0;
    let hi = geo.xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (geo.xs[mid] < px) lo = mid;
      else hi = mid;
    }
    setHover(Math.abs(geo.xs[lo] - px) <= Math.abs(geo.xs[hi] - px) ? lo : hi);
  };

  const hp = hover != null ? points[hover] : null;
  const last = points[points.length - 1];
  const first = points[0];
  const pnl = last.equity_usd - start;
  const pnlPct = start > 0 ? (pnl / start) * 100 : 0;
  const periodMove = last.equity_usd - first.equity_usd;
  const stroke = pnl >= 0 ? "var(--color-up)" : "var(--color-down)";
  const gradient = gradientId.replace(/:/g, "");

  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-bg/35">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-3">Equity sekarang</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">{usd.format(last.equity_usd)}</div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right text-xs">
          <div className="rounded-md border border-line bg-panel/70 px-3 py-2">
            <div className="text-ink-3">Total PnL</div>
            <div className={`mt-0.5 font-semibold tabular-nums ${pnl >= 0 ? "text-up" : "text-down"}`}>
              {pnl >= 0 ? "+" : ""}
              {usd.format(pnl)}
            </div>
          </div>
          <div className="rounded-md border border-line bg-panel/70 px-3 py-2">
            <div className="text-ink-3">Return</div>
            <div className={`mt-0.5 font-semibold tabular-nums ${pnl >= 0 ? "text-up" : "text-down"}`}>
              {fmtSignedPct(pnlPct, 2)}
            </div>
          </div>
          <div className="rounded-md border border-line bg-panel/70 px-3 py-2">
            <div className="text-ink-3">Terbuka</div>
            <div className="mt-0.5 font-semibold tabular-nums text-ink">{last.open_count}</div>
          </div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none px-2 py-2"
        role="img"
        aria-label={`Equity paper trading, sekarang ${usd.format(last.equity_usd)}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`${gradient}-area`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.26" />
            <stop offset="58%" stopColor={stroke} stopOpacity="0.09" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${gradient}-line`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--color-accent)" />
            <stop offset="100%" stopColor={stroke} />
          </linearGradient>
        </defs>
        <rect
          x={PAD.left}
          y={PAD.top}
          width={W - PAD.left - PAD.right}
          height={H - PAD.top - PAD.bottom}
          rx={10}
          fill="var(--color-panel)"
          opacity={0.38}
        />
        {geo.ticks.map((v, i) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={geo.y(v)}
              y2={geo.y(v)}
              stroke={i === geo.ticks.length - 1 ? "var(--color-line-strong)" : "var(--color-line)"}
              strokeWidth={1}
              opacity={i === geo.ticks.length - 1 ? 0.9 : 0.62}
            />
            <text x={PAD.left - 12} y={geo.y(v) + 4} textAnchor="end" fontSize={12} fill="var(--color-ink-3)">
              {usd.format(v)}
            </text>
          </g>
        ))}
        {geo.timeTicks.map((t, i) => (
          <text
            key={t}
            x={geo.x(t)}
            y={H - 14}
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
            fontSize={12}
            fill="var(--color-ink-3)"
          >
            {i === 0 || i === geo.timeTicks.length - 1 || i === 2 ? fmtDateTime(t) : ""}
          </text>
        ))}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={geo.y(start)}
          y2={geo.y(start)}
          stroke="var(--color-ink-3)"
          strokeDasharray="6 6"
          strokeWidth={1}
          opacity={0.9}
        />
        <text x={W - PAD.right - 4} y={geo.y(start) - 8} textAnchor="end" fontSize={11} fill="var(--color-ink-3)">
          Modal awal
        </text>
        <path d={geo.area} fill={`url(#${gradient}-area)`} />
        <path
          d={geo.path}
          fill="none"
          stroke={`url(#${gradient}-line)`}
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
          filter="drop-shadow(0 8px 16px rgba(0,0,0,0.26))"
        />
        <circle
          cx={geo.plot[geo.plot.length - 1].x}
          cy={geo.plot[geo.plot.length - 1].y}
          r={5}
          fill={stroke}
          stroke="var(--color-bg)"
          strokeWidth={3}
        />
        {hp && hover != null && (
          <g>
            <line
              x1={geo.xs[hover]}
              x2={geo.xs[hover]}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--color-line-strong)"
              strokeWidth={1}
            />
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={geo.y(hp.equity_usd)}
              y2={geo.y(hp.equity_usd)}
              stroke="var(--color-line-strong)"
              strokeDasharray="3 5"
              strokeWidth={1}
              opacity={0.85}
            />
            <circle
              cx={geo.xs[hover]}
              cy={geo.y(hp.equity_usd)}
              r={6}
              fill={stroke}
              stroke="var(--color-panel)"
              strokeWidth={3}
            />
          </g>
        )}
        <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} fill="transparent" />
      </svg>
      {hp && hover != null && (
        <div
          className="pointer-events-none absolute top-24 z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-raised/95 px-3 py-2 text-xs shadow-xl shadow-black/50 backdrop-blur"
          style={{ left: `${Math.min(88, Math.max(12, (geo.xs[hover] / W) * 100))}%` }}
        >
          <div className="text-ink-3">{fmtDateTime(hp.ts)} WIB</div>
          <div className="mt-0.5 font-semibold tabular-nums text-ink">{usd.format(hp.equity_usd)}</div>
          <div className="text-ink-3">
            {hp.open_count} posisi terbuka · {fmtSignedPct(start > 0 ? ((hp.equity_usd - start) / start) * 100 : 0, 2)}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-ink-3">
        <span>
          Rentang {fmtDateTime(first.ts)} WIB - {fmtDateTime(last.ts)} WIB
        </span>
        <span className={periodMove >= 0 ? "text-up" : "text-down"}>
          Gerak periode {periodMove >= 0 ? "+" : ""}
          {usd.format(periodMove)}
        </span>
      </div>
    </div>
  );
}
