import { SearchIcon } from "./icons";

export type TierFilter = "all" | "low" | "medium" | "high";

const SEGMENTS: { id: TierFilter; label: string }[] = [
  { id: "all", label: "Semua" },
  { id: "low", label: "Risiko rendah" },
  { id: "medium", label: "Menengah" },
  { id: "high", label: "Tinggi" },
];

const TVL_OPTIONS = [
  { value: 0, label: "Semua TVL" },
  { value: 25_000, label: "TVL ≥ $25K" },
  { value: 100_000, label: "TVL ≥ $100K" },
  { value: 500_000, label: "TVL ≥ $500K" },
];

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
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line bg-raised/20 px-4 py-3">
      <div role="tablist" className="flex max-w-full overflow-x-auto rounded-lg border border-line bg-bg/80 p-1 shadow-inner shadow-black/20">
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={tierFilter === s.id}
            onClick={() => onTierFilter(s.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tierFilter === s.id ? "bg-raised text-ink shadow-sm shadow-black/25" : "text-ink-3 hover:bg-raised/50 hover:text-ink-2"
            }`}
          >
            {s.label}
            <span className={`rounded px-1.5 py-0.5 tabular-nums ${tierFilter === s.id ? "bg-bg/80 text-ink-2" : "text-ink-3"}`}>
              {counts[s.id]}
            </span>
          </button>
        ))}
      </div>

      <label className="relative flex w-full min-w-0 flex-none items-center sm:min-w-[240px] sm:flex-[1_1_280px] sm:max-w-80">
        <SearchIcon className="pointer-events-none absolute left-2.5 text-ink-3" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Cari pair atau alamat"
          className="w-full rounded-lg border border-line bg-bg/85 py-2 pl-8 pr-3 text-sm text-ink shadow-inner shadow-black/20 placeholder:text-ink-3 outline-none transition-colors focus:border-accent/70"
        />
      </label>

      <select
        value={minTvl}
        onChange={(e) => onMinTvl(Number(e.target.value))}
        className="w-full rounded-lg border border-line bg-bg/85 px-3 py-2 text-sm text-ink-2 outline-none transition-colors focus:border-accent/70 sm:w-auto"
      >
        {TVL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select
        value={binStep}
        onChange={(e) => onBinStep(Number(e.target.value))}
        aria-label="Filter bin step"
        className="w-full rounded-lg border border-line bg-bg/85 px-3 py-2 text-sm text-ink-2 outline-none transition-colors focus:border-accent/70 sm:w-auto"
      >
        <option value={0}>Semua bin step</option>
        {binSteps.map((s) => (
          <option key={s} value={s}>
            Bin step {s} ({(s / 100).toFixed(2)}%)
          </option>
        ))}
      </select>

      <button
        role="switch"
        aria-checked={hideExcluded}
        onClick={() => onHideExcluded(!hideExcluded)}
        className="flex max-w-full items-center gap-2 rounded-lg border border-transparent px-1.5 py-1 text-left text-sm text-ink-2 transition-colors hover:border-line hover:bg-bg/50 hover:text-ink"
      >
        <span
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            hideExcluded ? "border-accent/60 bg-accent/30" : "border-line-strong bg-raised"
          }`}
        >
          <span
            className={`absolute left-0 top-[2px] h-3.5 w-3.5 rounded-full bg-ink transition-transform ${
              hideExcluded ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </span>
        Sembunyikan yang tidak direkomendasikan
      </button>

      <span className="ml-auto rounded-full border border-line bg-bg/60 px-2.5 py-1 text-xs font-medium text-ink-3">
        {shown} pool ditampilkan
      </span>
    </div>
  );
}
