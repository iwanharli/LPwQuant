"use client";

import { useCallback, useMemo, useState } from "react";
import { type SortKey, type Tier, rowTier } from "../lib/types";
import { useLivePools } from "../lib/use-live-pools";
import KpiStrip from "./kpi-strip";
import PoolDrawer from "./pool-drawer";
import PoolTable from "./pool-table";
import Toolbar, { type TierFilter } from "./toolbar";
import TopBar from "./top-bar";

export default function Dashboard() {
  const { pools, status, lastMessageAt } = useLivePools();
  const [selected, setSelected] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDesc, setSortDesc] = useState(true);
  const [query, setQuery] = useState("");
  const [minTvl, setMinTvl] = useState(0);
  const [binStep, setBinStep] = useState(0);
  const [hideExcluded, setHideExcluded] = useState(true);
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");

  const all = useMemo(() => [...pools.values()], [pools]);
  const binSteps = useMemo(() => [...new Set(all.map((p) => p.bin_step))].sort((a, b) => a - b), [all]);

  // Everything except the tier tab, so tab counts reflect the other filters.
  const baseFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (p) =>
        p.tvl >= minTvl &&
        (!binStep || p.bin_step === binStep) &&
        (!hideExcluded || p.plan.action !== "avoid") &&
        (!q || p.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q)),
    );
  }, [all, query, minTvl, binStep, hideExcluded]);

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
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Pool DLMM</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-3">
            Dikelompokkan per tingkat risiko. Di dalam tiap tier, diurutkan berdasarkan skor peluang fee, likuiditas,
            dan keamanan.
          </p>
          </div>
          <div className="hidden rounded-lg border border-line bg-panel/70 px-3 py-2 text-right shadow-sm shadow-black/20 lg:block">
            <div className="text-[11px] uppercase tracking-wider text-ink-3">Mode</div>
            <div className="text-sm font-semibold text-ink">Live risk screener</div>
          </div>
        </div>

        <KpiStrip rows={all} />

        <section className="max-w-full overflow-hidden rounded-2xl border border-line bg-panel/95 shadow-[0_18px_55px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)]">
          <Toolbar
            tierFilter={tierFilter}
            onTierFilter={setTierFilter}
            counts={counts}
            query={query}
            onQuery={setQuery}
            minTvl={minTvl}
            onMinTvl={setMinTvl}
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

      <PoolDrawer row={selectedRow} onClose={closeDrawer} />
    </div>
  );
}
