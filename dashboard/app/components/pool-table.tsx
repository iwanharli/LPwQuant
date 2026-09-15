import { STRATEGY_LABEL } from "../lib/flags";
import { binStepPct, fmtAge, fmtPct, fmtPrice, usdCompact } from "../lib/format";
import { isActivePlan, type ConnectionStatus, type PoolRow, type SortKey } from "../lib/types";
import { Delta, FlagChips, PlanBadge, RegimeBadge, ScoreCell, TokenAvatar } from "./ui";

type Column = { label: string; title?: string; sort?: SortKey; align?: "left" | "right" };

const COLUMNS: Column[] = [
  { label: "Pool", align: "left" },
  { label: "Tier risiko", align: "left", title: "Rendah / menengah / tinggi, dengan strategi dan range" },
  { label: "Skor", sort: "score", align: "left", title: "Skor heuristik v2 (0–100)" },
  { label: "Rezim", align: "left", title: "Rezim pasar dari ADX dan Choppiness (candle 30m)" },
  { label: "Harga", title: "Harga token dasar dalam token quote" },
  {
    label: "Bin step",
    sort: "bin_step",
    title: "Selisih harga antar bin (basis poin). Kecil = likuiditas rapat, besar = range lebar per posisi",
  },
  { label: "1 jam", sort: "change_pct_1h", title: "Perubahan harga 1 jam" },
  { label: "Volatilitas", sort: "realized_vol_pct_1h", title: "Realized volatility 1 jam" },
  { label: "TVL", sort: "tvl" },
  { label: "Volume 24j", sort: "volume_24h" },
  {
    label: "Fee posisi/hari",
    sort: "fee_for_position_pct_day",
    title: "Perkiraan fee harian untuk ukuran posisimu, bobot jam terakhir, setelah dilusi",
  },
  { label: "Fee/TVL 24j", sort: "fee_tvl_pct_24h" },
  { label: "Umur", sort: "pool_age_hours" },
  { label: "Sinyal", align: "left" },
];

export default function PoolTable({
  rows,
  status,
  selected,
  onSelect,
  sortKey,
  sortDesc,
  onSort,
}: {
  rows: PoolRow[];
  status: ConnectionStatus;
  selected: string | null;
  onSelect: (address: string) => void;
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div className="max-h-[calc(100vh-18rem)] min-h-80 overflow-auto">
      <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {COLUMNS.map((c) => {
              const active = c.sort && c.sort === sortKey;
              return (
                <th
                  key={c.label}
                  scope="col"
                  title={c.title}
                  aria-sort={active ? (sortDesc ? "descending" : "ascending") : undefined}
                  className={`sticky top-0 z-10 whitespace-nowrap border-b border-line bg-panel/95 px-3 py-3 text-[11px] font-semibold uppercase tracking-wider text-ink-3 backdrop-blur first:pl-4 last:pr-4 ${
                    c.align === "left" ? "text-left" : "text-right"
                  }`}
                >
                  {c.sort ? (
                    <button
                      onClick={() => onSort(c.sort!)}
                      className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-ink ${
                        active ? "text-ink" : ""
                      }`}
                    >
                      {c.label}
                      <span className={`text-[9px] text-accent ${active ? "opacity-100" : "opacity-0"}`}>
                        {sortDesc ? "▼" : "▲"}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const isSelected = selected === p.address;
            const plan = p.plan;
            return (
              <tr
                key={p.address}
                tabIndex={0}
                aria-selected={isSelected}
                onClick={() => onSelect(p.address)}
                onKeyDown={(e) => e.key === "Enter" && onSelect(p.address)}
                className={`group cursor-pointer outline-none transition-colors ${
                  isSelected ? "bg-accent/12" : "hover:bg-hover/80 focus-visible:bg-hover"
                }`}
              >
                <td className={`border-b border-line/80 py-3 pl-4 pr-3 ${isSelected ? "shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}>
                  <div className="flex items-center gap-3">
                    <span className="w-6 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
                    <TokenAvatar symbol={p.base_symbol} />
                    <div className="min-w-0">
                      <div className="truncate whitespace-nowrap font-medium text-ink">{p.name}</div>
                      <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-3">
                        <span>Fee {p.base_fee_pct}%</span>
                        {p.watched && (
                          <>
                            <span>·</span>
                            <span className="text-ink-2" title="Harga on-chain (poll RPC)">
                              On-chain
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="border-b border-line/80 px-3 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <PlanBadge plan={plan} />
                    <span className="max-w-44 truncate text-[11px] text-ink-3" title={isActivePlan(plan) ? plan.note : plan.reason}>
                      {isActivePlan(plan)
                        ? `${STRATEGY_LABEL[plan.strategy]} ${plan.range_low_pct}% / +${plan.range_high_pct}%`
                        : plan.reason}
                    </span>
                  </div>
                </td>
                <td className="border-b border-line/80 px-3 py-3">
                  <ScoreCell score={p.score} />
                </td>
                <td className="border-b border-line/80 px-3 py-3">
                  <RegimeBadge regime={p.regime} adx={p.market?.adx} />
                </td>
                <td className="border-b border-line/80 px-3 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2">
                  {fmtPrice(p.price)}
                </td>
                <td className="whitespace-nowrap border-b border-line/80 px-3 py-3 text-right tabular-nums">
                  <span className="text-ink">{p.bin_step}</span>
                  <span className="ml-1.5 text-[11px] text-ink-3">{binStepPct(p.bin_step)}</span>
                </td>
                <td className="border-b border-line/80 px-3 py-3 text-right">
                  <Delta value={p.change_pct_1h} />
                </td>
                <td className="border-b border-line/80 px-3 py-3 text-right tabular-nums text-ink-2">
                  {fmtPct(p.realized_vol_pct_1h)}
                </td>
                <td className="border-b border-line/80 px-3 py-3 text-right tabular-nums">{usdCompact.format(p.tvl)}</td>
                <td className="border-b border-line/80 px-3 py-3 text-right tabular-nums text-ink-2">
                  {usdCompact.format(p.volume_24h)}
                </td>
                <td className="border-b border-line/80 px-3 py-3 text-right font-semibold tabular-nums text-ink">
                  {fmtPct(p.fee_for_position_pct_day, 2)}
                </td>
                <td className="border-b border-line/80 px-3 py-3 text-right tabular-nums text-ink-2">
                  {fmtPct(p.fee_tvl_pct_24h, 2)}
                </td>
                <td className="border-b border-line/80 px-3 py-3 text-right tabular-nums text-ink-2">
                  {fmtAge(p.pool_age_hours)}
                </td>
                <td className="border-b border-line/80 py-3 pl-3 pr-4">
                  <FlagChips flags={p.flags} max={2} />
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="px-4 py-20 text-center text-sm text-ink-3">
                <div className="mx-auto max-w-sm rounded-xl border border-line bg-bg/55 px-5 py-6 shadow-inner shadow-black/20">
                  <div className="text-base font-medium text-ink">
                    {status === "live" ? "Tidak ada pool yang cocok" : "Menghubungkan ke engine"}
                  </div>
                  <div className="mt-1 text-sm text-ink-3">
                    {status === "live" ? "Coba longgarkan filter atau tampilkan pool yang tidak direkomendasikan." : "Data akan muncul otomatis saat koneksi siap."}
                  </div>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
