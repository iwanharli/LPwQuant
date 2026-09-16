"use client";

import { useMemo, useState, type MouseEvent } from "react";
import { fmtDateTime, fmtSignedPct, usd } from "../../lib/format";
import type { EquityPoint } from "../../lib/paper-types";

const W = 1000;
const H = 340;
const PAD = { left: 76, right: 118, top: 26, bottom: 42 };
const LABEL_GAP = 16;

export type EquitySeries = { key: string; label: string; color: string; points: EquityPoint[] };

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

function nearest(points: EquityPoint[], ts: number): EquityPoint | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts < ts) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].ts - ts) <= Math.abs(points[hi].ts - ts) ? points[lo] : points[hi];
}

/** Spread end labels vertically so they never overlap, keeping them as close to their line ends as possible. */
function spreadLabels(ys: number[], top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const placed = order.map((o) => o.y);
  for (let k = 1; k < placed.length; k++) placed[k] = Math.max(placed[k], placed[k - 1] + LABEL_GAP);
  const overflow = placed.length ? placed[placed.length - 1] - bottom : 0;
  if (overflow > 0) for (let k = 0; k < placed.length; k++) placed[k] -= overflow;
  for (let k = placed.length - 2; k >= 0; k--) placed[k] = Math.min(placed[k], placed[k + 1] - LABEL_GAP);
  if (placed.length && placed[0] < top) for (let k = 0; k < placed.length; k++) placed[k] += top - placed[0];
  const out = new Array<number>(ys.length);
  order.forEach((o, k) => (out[o.i] = placed[k]));
  return out;
}

/** Equity of every risk profile on one axis: one line per profile, dashed starting-capital baseline,
 * direct labels at the line ends, crosshair tooltip listing all profiles at the hovered time. */
export default function EquityChart({
  series,
  start,
  selected,
}: {
  series: EquitySeries[];
  start: number;
  selected?: string;
}) {
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const drawable = useMemo(() => series.filter((s) => s.points.length >= 2), [series]);

  const geo = useMemo(() => {
    if (drawable.length === 0) return null;
    const all = drawable.flatMap((s) => s.points);
    const t0 = Math.min(...all.map((p) => p.ts));
    const t1 = Math.max(...all.map((p) => p.ts));
    const values = all.map((p) => p.equity_usd).concat(start);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max - min < 0.5) {
      min -= 0.5;
      max += 0.5;
    }
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
    const x = (t: number) => PAD.left + ((t - t0) / Math.max(t1 - t0, 1)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);
    const lines = drawable.map((s) => {
      const plot = s.points.map((p) => ({ x: x(p.ts), y: y(p.equity_usd) }));
      return { ...s, plot, path: smoothPath(plot), end: plot[plot.length - 1] };
    });
    const labelYs = spreadLabels(
      lines.map((l) => l.end.y),
      PAD.top + 6,
      H - PAD.bottom - 4,
    );
    const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4).reverse();
    const timeTicks = [0, 0.5, 1].map((f) => t0 + (t1 - t0) * f);
    return { x, y, t0, t1, lines, labelYs, ticks, timeTicks };
  }, [drawable, start]);

  if (!geo) {
    return (
      <div className="grid h-72 place-items-center rounded-lg border border-line bg-bg/35 text-sm text-ink-3">
        <div className="text-center">
          <div className="text-base font-medium text-ink">Menunggu titik equity</div>
          <div className="mt-1">Kurva muncul setelah beberapa siklus engine (sekitar 1 menit per titik).</div>
        </div>
      </div>
    );
  }

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const f = Math.min(1, Math.max(0, (px - PAD.left) / (W - PAD.left - PAD.right)));
    setHoverTs(geo.t0 + f * (geo.t1 - geo.t0));
  };

  const hovered =
    hoverTs == null
      ? null
      : geo.lines.map((l) => ({ line: l, point: nearest(l.points, hoverTs) })).filter((h) => h.point != null);
  const hoverX = hoverTs != null ? geo.x(hoverTs) : null;
  const latest = series.map((s) => ({ s, last: s.points[s.points.length - 1] ?? null }));

  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-bg/35">
      <div className="grid grid-cols-1 gap-2 border-b border-line px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
        {latest.map(({ s, last }) => {
          const equity = last?.equity_usd ?? start;
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

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none px-2 py-2"
        role="img"
        aria-label={`Equity per profil: ${latest
          .map(({ s, last }) => `${s.label} ${usd.format(last?.equity_usd ?? start)}`)
          .join(", ")}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverTs(null)}
      >
        {geo.ticks.map((v, i) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={geo.y(v)}
              y2={geo.y(v)}
              stroke={i === geo.ticks.length - 1 ? "var(--color-line-strong)" : "var(--color-line)"}
              strokeWidth={1}
              opacity={0.6}
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
            textAnchor={i === 0 ? "start" : i === geo.timeTicks.length - 1 ? "end" : "middle"}
            fontSize={12}
            fill="var(--color-ink-3)"
          >
            {i > 0 && fmtDateTime(t) === fmtDateTime(geo.timeTicks[i - 1]) ? "" : fmtDateTime(t)}
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
          opacity={0.8}
        />
        <text x={PAD.left + 8} y={geo.y(start) - 7} fontSize={11} fill="var(--color-ink-3)">
          Modal awal {usd.format(start)}
        </text>

        {/* Selected profile drawn last so it sits on top. */}
        {[...geo.lines]
          .sort((a, b) => Number(a.key === selected) - Number(b.key === selected))
          .map((l) => {
            const active = l.key === selected;
            return (
              <g key={l.key}>
                <path
                  d={l.path}
                  fill="none"
                  stroke="var(--color-bg)"
                  strokeWidth={active ? 6 : 4}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.9}
                />
                <path
                  d={l.path}
                  fill="none"
                  stroke={l.color}
                  strokeWidth={active ? 3 : 2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={selected && !active ? 0.8 : 1}
                />
                <circle cx={l.end.x} cy={l.end.y} r={4} fill={l.color} stroke="var(--color-bg)" strokeWidth={2} />
              </g>
            );
          })}

        {geo.lines.map((l, i) => (
          <g key={`label-${l.key}`}>
            <line
              x1={l.end.x + 6}
              x2={W - PAD.right + 10}
              y1={l.end.y}
              y2={geo.labelYs[i]}
              stroke="var(--color-line-strong)"
              strokeWidth={1}
              opacity={Math.abs(l.end.y - geo.labelYs[i]) > 2 ? 0.8 : 0}
            />
            <text
              x={W - PAD.right + 14}
              y={geo.labelYs[i] + 4}
              fontSize={12}
              fontWeight={l.key === selected ? 600 : 500}
              fill="var(--color-ink-2)"
            >
              {l.label}
            </text>
          </g>
        ))}

        {hovered && hoverX != null && (
          <g>
            <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--color-line-strong)" strokeWidth={1} />
            {hovered.map(({ line, point }) => (
              <circle
                key={line.key}
                cx={geo.x(point!.ts)}
                cy={geo.y(point!.equity_usd)}
                r={5}
                fill={line.color}
                stroke="var(--color-panel)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      </svg>

      {hovered && hoverX != null && hoverTs != null && (
        <div
          className="pointer-events-none absolute top-28 z-10 min-w-52 -translate-x-1/2 rounded-lg border border-line-strong bg-raised/95 px-3 py-2 text-xs shadow-xl shadow-black/50 backdrop-blur"
          style={{ left: `${Math.min(80, Math.max(18, (hoverX / W) * 100))}%` }}
        >
          <div className="mb-1 text-ink-3">{fmtDateTime(hoverTs)} WIB</div>
          {[...hovered]
            .sort((a, b) => b.point!.equity_usd - a.point!.equity_usd)
            .map(({ line, point }) => (
              <div key={line.key} className="flex items-center justify-between gap-4 py-0.5 tabular-nums">
                <span className="flex items-center gap-2 text-ink-2">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: line.color }} aria-hidden />
                  {line.label}
                </span>
                <span className="text-ink">
                  {usd.format(point!.equity_usd)}{" "}
                  <span className="text-ink-3">
                    {fmtSignedPct(start > 0 ? ((point!.equity_usd - start) / start) * 100 : 0, 2)} · {point!.open_count} pos
                  </span>
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
