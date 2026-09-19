"use client";

import { useEffect, useRef } from "react";
import { TIER_META } from "../lib/flags";
import { ChevronIcon, SearchIcon } from "./icons";
import { StatusDot } from "./ui";

export type TierFilter = "all" | "low" | "medium" | "high";

const SEGMENTS: { id: TierFilter; label: string }[] = [
  { id: "all", label: "Semua" },
  { id: "low", label: TIER_META.low.short },
  { id: "medium", label: TIER_META.medium.short },
  { id: "high", label: TIER_META.high.short },
];

const TVL_OPTIONS = [
  { value: 0, label: "Semua" },
  { value: 25_000, label: "≥ $25K" },
  { value: 100_000, label: "≥ $100K" },
  { value: 500_000, label: "≥ $500K" },
];

const GROUP_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-ink-3";

function chipClass(active: boolean) {
  return `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
    active
      ? "border-accent/70 bg-accent/10 text-ink"
      : "border-line bg-bg/40 text-ink-2 hover:border-line-strong hover:text-ink"
  }`;
}

export default function Toolbar({
  tierFilter,
  onTierFilter,
  counts,
  query,
  onQuery,
  minTvl,
  onMinTvl,
  binStep,
  onBinStep,
  binSteps,
  hideExcluded,
  onHideExcluded,
  shown,
  filterCount,
  onOpenFilters,
  onClearFilters,
}: {
  tierFilter: TierFilter;
  onTierFilter: (v: TierFilter) => void;
  counts: Record<TierFilter, number>;
  query: string;
  onQuery: (v: string) => void;
  minTvl: number;
  onMinTvl: (v: number) => void;
  binStep: number;
  onBinStep: (v: number) => void;
  binSteps: number[];
  hideExcluded: boolean;
  onHideExcluded: (v: boolean) => void;
  shown: number;
  filterCount: number;
  onOpenFilters: () => void;
  onClearFilters: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search box from anywhere on the page, unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Counts the advanced panel too, so "Reset filter" never hides filters it did not clear.
  const filtersActive = tierFilter !== "all" || query !== "" || binStep !== 0 || filterCount > 0;
  const reset = () => {
    onTierFilter("all");
    onQuery("");
    onBinStep(0);
    onClearFilters();
  };

  return (
    <div className="space-y-3 border-b border-line px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex min-w-0 flex-1 basis-72 items-center">
          <SearchIcon className="pointer-events-none absolute left-3.5 text-ink-3" width={17} height={17} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (onQuery(""), e.currentTarget.blur())}
            placeholder="Cari pair, token, alamat token atau pool"
            aria-label="Cari pool"
            className="h-11 w-full rounded-xl border border-line bg-bg/70 pl-10 pr-12 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-accent/70 focus:bg-bg/90"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQuery("")}
              aria-label="Hapus pencarian"
              className="absolute right-2.5 rounded-md px-2 py-1 text-xs text-ink-3 transition-colors hover:bg-raised hover:text-ink"
            >
              Hapus
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-3 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-3">
              /
            </kbd>
          )}
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={hideExcluded}
          onClick={() => onHideExcluded(!hideExcluded)}
          className="flex items-center gap-2 rounded-full px-1 py-1 text-xs font-medium text-ink-2 transition-colors hover:text-ink"
        >
          <span
            className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
              hideExcluded ? "border-accent/70 bg-accent/80" : "border-line-strong bg-raised"
            }`}
          >
            <span
              className={`absolute left-0 top-[2px] h-3.5 w-3.5 rounded-full transition-transform ${
                hideExcluded ? "translate-x-4 bg-bg" : "translate-x-0.5 bg-ink-2"
              }`}
            />
          </span>
          Sembunyikan tidak direkomendasikan
        </button>
        <div className="flex items-center gap-2 text-sm">
          <span className="tabular-nums font-semibold text-ink">{shown}</span>
          <span className="text-ink-3">pool ditampilkan</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Tier risiko">
          <span className={GROUP_LABEL}>Tier</span>
          {SEGMENTS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={tierFilter === s.id}
              onClick={() => onTierFilter(s.id)}
              className={chipClass(tierFilter === s.id)}
            >
              {s.id !== "all" && <StatusDot severity={TIER_META[s.id].severity} />}
              {s.label}
              <span className="tabular-nums text-ink-3">{counts[s.id]}</span>
            </button>
          ))}
        </div>

        <span className="hidden h-6 w-px bg-line lg:block" aria-hidden />

        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="TVL minimum">
          <span className={GROUP_LABEL}>TVL</span>
          {TVL_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={minTvl === o.value}
              onClick={() => onMinTvl(o.value)}
              className={chipClass(minTvl === o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>

        <span className="hidden h-6 w-px bg-line lg:block" aria-hidden />

        <label className="flex items-center gap-2">
          <span className={GROUP_LABEL}>Bin step</span>
          <span className="relative">
            <select
              value={binStep}
              onChange={(e) => onBinStep(Number(e.target.value))}
              aria-label="Filter bin step"
              className={`${chipClass(binStep !== 0)} appearance-none pr-8 outline-none focus-visible:border-accent/70`}
            >
              <option value={0}>Semua</option>
              {binSteps.map((s) => (
                <option key={s} value={s}>
                  {s} ({(s / 100).toFixed(2)}%)
                </option>
              ))}
            </select>
            <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3" width={14} height={14} />
          </span>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenFilters}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              filterCount > 0
                ? "border-accent/70 bg-accent/10 text-ink"
                : "border-line bg-bg/40 text-ink-2 hover:border-line-strong hover:text-ink"
            }`}
          >
            Filter lanjutan
            {filterCount > 0 && (
              <span className="rounded-full bg-accent/20 px-1.5 tabular-nums text-[11px] text-ink">{filterCount}</span>
            )}
          </button>
          {filtersActive && (
            <button
              type="button"
              onClick={reset}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-accent/70 hover:text-ink"
            >
              Reset filter
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
