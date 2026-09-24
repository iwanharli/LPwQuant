"use client";

import { rangeStatus, type Pool, type Position } from "./pool-card";

export type StatusFilter = "all" | "in_range" | "near_edge" | "out";
export type SortKey = "value" | "pnl_worst" | "fees" | "edge" | "newest";
export type Filters = { status: StatusFilter; query: string; sort: SortKey };

export const DEFAULT_FILTERS: Filters = { status: "all", query: "", sort: "value" };

const STATUS_OPTIONS: { value: StatusFilter; label: string; hint: string }[] = [
  { value: "all", label: "Semua", hint: "Semua posisi" },
  { value: "in_range", label: "In range", hint: "Harga di dalam range, jauh dari tepi" },
  { value: "near_edge", label: "Dekat tepi", hint: "Harga dalam 15% dari tepi range" },
  { value: "out", label: "Out of range", hint: "Tidak sedang mengumpulkan fee" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "value", label: "Nilai terbesar" },
  { value: "pnl_worst", label: "PnL terburuk dulu" },
  { value: "fees", label: "Fee terbanyak" },
  { value: "edge", label: "Paling dekat tepi" },
  { value: "newest", label: "Terbaru dibuka" },
];

function statusOf(p: Position): Exclude<StatusFilter, "all"> | null {
  const s = rangeStatus(p, p.active_bin).severity;
  return s === "critical" ? "out" : s === "warning" ? "near_edge" : s === "good" ? "in_range" : null;
}

function matchesStatus(p: Position, status: StatusFilter): boolean {
  return status === "all" || statusOf(p) === status;
}

/** Distance of the price to the nearer range edge, as a share of the range; out of range sorts first. */
function edgeDistance(p: Position): number {
  const pos = rangeStatus(p, p.active_bin).pos;
  if (pos == null) return 2;
  if (pos < 0 || pos > 1) return -1;
  return Math.min(pos, 1 - pos);
}

/** Pools that still have a matching position, each holding only its matching positions, in the chosen order. */
export function applyFilters(pools: Pool[], f: Filters): Pool[] {
  const q = f.query.trim().toLowerCase();
  const kept = pools
    .filter((pool) => !q || pool.name.toLowerCase().includes(q))
    .map((pool) => ({ ...pool, positions: pool.positions.filter((p) => matchesStatus(p, f.status)) }))
    .filter((pool) => pool.positions.length > 0 || (f.status === "all" && pool.positions.length === 0));
  const key = (pool: Pool): number => {
    const ps = pool.positions;
    switch (f.sort) {
      case "pnl_worst":
        return pool.pnl_usd;
      case "fees":
        return -ps.reduce((n, p) => n + p.unclaimed_fees_usd, 0);
      case "edge":
        return Math.min(...ps.map(edgeDistance), 2);
      case "newest":
        return -Math.max(...ps.map((p) => p.created_at ?? 0), 0);
      default:
        return -pool.value_usd;
    }
  };
  return kept.sort((a, b) => key(a) - key(b));
}

export function statusCounts(pools: Pool[]): Record<StatusFilter, number> {
  const all = pools.flatMap((pool) => pool.positions);
  const counts: Record<StatusFilter, number> = { all: all.length, in_range: 0, near_edge: 0, out: 0 };
  for (const p of all) {
    const s = statusOf(p);
    if (s) counts[s] += 1;
  }
  return counts;
}

function chipClass(active: boolean) {
  return `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
    active
      ? "border-accent/70 bg-accent/10 text-ink"
      : "border-line bg-bg/40 text-ink-2 hover:border-line-strong hover:text-ink"
  }`;
}

const DOT: Partial<Record<StatusFilter, string>> = {
  in_range: "bg-good",
  near_edge: "bg-warning",
  out: "bg-critical",
};

export default function PositionFilters({
  filters,
  onChange,
  counts,
  shown,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  counts: Record<StatusFilter, number>;
  shown: number;
}) {
  const changed = filters.status !== "all" || filters.query !== "" || filters.sort !== "value";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-white/[0.06] bg-panel px-4 py-3 shadow-[0_14px_42px_rgba(0,0,0,0.20)] backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter status posisi">
        {STATUS_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            title={o.hint}
            aria-pressed={filters.status === o.value}
            onClick={() => onChange({ ...filters, status: o.value })}
            className={chipClass(filters.status === o.value)}
          >
            {DOT[o.value] && <span className={`h-1.5 w-1.5 rounded-full ${DOT[o.value]}`} aria-hidden />}
            {o.label}
            <span className="tabular-nums text-ink-3">{counts[o.value]}</span>
          </button>
        ))}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
          placeholder="Cari token…"
          aria-label="Cari token"
          className="h-8 w-40 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none"
        />
        <select
          value={filters.sort}
          onChange={(e) => onChange({ ...filters, sort: e.target.value as SortKey })}
          aria-label="Urutkan"
          className="h-8 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-ink-2 focus:border-accent/50 focus:outline-none"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {changed && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTERS)}
            className="h-8 rounded-full px-2 text-xs text-ink-3 hover:text-ink"
          >
            Reset
          </button>
        )}
        <span className="text-xs tabular-nums text-ink-3">{shown} posisi</span>
      </div>
    </div>
  );
}
