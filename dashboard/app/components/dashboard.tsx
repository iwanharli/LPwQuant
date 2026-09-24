"use client";

import { useCallback, useMemo, useState } from "react";
import { type Filters, activeFilterCount, defaultFilters, emptyFilters, matchesFilters } from "../lib/filters";
import { type SortKey, type Tier, rowTier } from "../lib/types";
import { useLivePools } from "../lib/use-live-pools";
import FilterPanel from "./filter-panel";
import BusyHours from "./busy-hours";
import KpiStrip from "./kpi-strip";
import PoolDrawer from "./pool-drawer";
import PoolTable from "./pool-table";
import Toolbar, { type TierFilter } from "./toolbar";
import TopBar from "./top-bar";
import PageHeader from "./page-header";

export default function Dashboard() {
  const { pools, status, lastMessageAt } = useLivePools();
  const [selected, setSelected] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDesc, setSortDesc] = useState(true);
  const [query, setQuery] = useState("");
  const [binStep, setBinStep] = useState(0);
  const [hideExcluded, setHideExcluded] = useState(true);
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const all = useMemo(() => [...pools.values()], [pools]);
  const binSteps = useMemo(() => [...new Set(all.map((p) => p.bin_step))].sort((a, b) => a - b), [all]);

  // Everything except the tier tab, so tab counts reflect the other filters.
  const baseFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (p) =>
        matchesFilters(p, filters) &&
        (!binStep || p.bin_step === binStep) &&
        (!hideExcluded || p.plan.action !== "avoid") &&
        (!q || p.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q) || (p.base_mint ?? "").toLowerCase().includes(q)),
    );
  }, [all, query, filters, binStep, hideExcluded]);

  const counts = useMemo(() => {
    const byTier = (t: Tier) => baseFiltered.filter((p) => rowTier(p) === t).length;
    return { all: baseFiltered.length, low: byTier("low"), medium: byTier("medium"), high: byTier("high") };
  }, [baseFiltered]);

  const rows = useMemo(() => {
    const dir = sortDesc ? -1 : 1;
    return baseFiltered
      .filter((p) => tierFilter === "all" || rowTier(p) === tierFilter)
      .sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av - bv) * dir;
      });
  }, [baseFiltered, tierFilter, sortKey, sortDesc]);

  const onSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) setSortDesc((d) => !d);
      else {
        setSortKey(key);
        setSortDesc(true);
      }
    },
    [sortKey],
  );
  const closeDrawer = useCallback(() => setSelected(null), []);
  const selectedRow = selected ? (pools.get(selected) ?? null) : null;

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar status={status} lastMessageAt={lastMessageAt} />

      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader title="Pool DLMM" subtitle="Pool diurutkan per tingkat risiko dan skor peluang fee." />

        <KpiStrip rows={all} />

        {/* Collapsed by default: a reference for timing entries, not something to read on every visit. */}
        <details className="group rounded-2xl border border-line bg-panel/90 shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
            <svg viewBox="0 0 20 20" width={14} height={14} className="text-ink-3 transition-transform group-open:rotate-90" aria-hidden>
              <path d="m7.5 5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Jam ramai pasar (WIB)
            <span className="font-normal text-ink-3">· kapan volume DLMM paling tinggi, dari 30 hari candle</span>
          </summary>
          <div className="border-t border-line px-4 py-3">
            <BusyHours />
          </div>
        </details>

        <section className="max-w-full overflow-x-clip rounded-2xl border border-line bg-panel/95 shadow-[0_18px_55px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)]">
          <Toolbar
            tierFilter={tierFilter}
            onTierFilter={setTierFilter}
            counts={counts}
            query={query}
            onQuery={setQuery}
            minTvl={filters.tvl.min ?? 0}
            onMinTvl={(v) => setFilters((f) => ({ ...f, tvl: { ...f.tvl, min: v || null } }))}
            filterCount={activeFilterCount(filters)}
            onOpenFilters={() => setFiltersOpen(true)}
            onClearFilters={() => setFilters(emptyFilters())}
            binStep={binStep}
            onBinStep={setBinStep}
            binSteps={binSteps}
            hideExcluded={hideExcluded}
            onHideExcluded={setHideExcluded}
            shown={rows.length}
          />
          <PoolTable
            rows={rows}
            status={status}
            selected={selected}
            onSelect={(address) => setSelected((cur) => (cur === address ? null : address))}
            sortKey={sortKey}
            sortDesc={sortDesc}
            onSort={onSort}
          />
        </section>

        <p className="pb-2 text-center text-xs text-ink-3">
          Tier dan rencana posisi masih heuristik. Backtest belum menunjukkan edge positif. Bukan saran finansial.
        </p>
      </main>

      <FilterPanel
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={filters}
        onChange={setFilters}
        shown={rows.length}
        total={all.length}
      />

      <PoolDrawer row={selectedRow} onClose={closeDrawer} />
    </div>
  );
}
