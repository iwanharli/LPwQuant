import Link from "next/link";
import type { ReactNode } from "react";
import { STRATEGY_LABEL } from "../lib/flags";
import { binStepPct, fmtAge, fmtPct, fmtPrice, usdCompact } from "../lib/format";
import { isActivePlan, type ConnectionStatus, type PoolRow, type SortKey } from "../lib/types";
import { CandleIcon, ExternalLinkIcon } from "./icons";
import { Delta, FlagChips, PlanBadge, RegimeBadge, ScoreCell, TokenAvatar } from "./ui";

/**
 * Related metrics share a cell (primary value on top, secondary below) so the table fits laptop widths
 * (~1280px) without horizontal scrolling. Every metric stays sortable from the header.
 */
type Column = {
  label: string;
  title?: string;
  sorts?: { key: SortKey; label: string }[];
  align?: "left" | "right";
};

const COLUMNS: Column[] = [
  { label: "Pool", align: "left", sorts: [{ key: "pool_age_hours", label: "Umur" }] },
  { label: "Tier risiko", align: "left", title: "Rendah / menengah / tinggi, dengan strategi dan range" },
  {
    label: "Skor · Rezim",
    align: "left",
    title: "Skor heuristik (0–100); rezim pasar dari ADX dan Choppiness (candle 30m)",
    sorts: [{ key: "score", label: "Skor" }],
  },
  {
    label: "Harga · Bin",
    title: "Harga token dasar dalam token quote; bin step (basis poin) dan jarak harga per bin",
    sorts: [{ key: "bin_step", label: "Bin" }],
  },
  {
    label: "1j · Volatilitas",
    title: "Perubahan harga 1 jam; realized volatility 1 jam",
    sorts: [
      { key: "change_pct_1h", label: "1j" },
      { key: "realized_vol_pct_1h", label: "Vol" },
    ],
  },
  {
    label: "TVL · Volume",
    title: "Total value locked; volume swap 24 jam",
    sorts: [
      { key: "tvl", label: "TVL" },
      { key: "volume_24h", label: "Vol 24j" },
    ],
  },
  {
    label: "Fee posisi · 24j",
    title: "Perkiraan fee harian untuk ukuran posisimu (setelah dilusi); fee/TVL 24 jam pool",
    sorts: [
      { key: "fee_for_position_pct_day", label: "Fee/hari" },
      { key: "fee_tvl_pct_24h", label: "24j" },
    ],
  },
  { label: "", title: "Buka grafik detail atau pool di Meteora" },
];

const CELL = "border-b border-line/80 px-2.5 py-2.5";
const ICON_BUTTON =
  "grid h-8 w-8 place-items-center rounded-md border border-line bg-bg/40 text-ink-3 transition-colors hover:border-line-strong hover:bg-raised hover:text-ink focus-visible:text-ink";

function Stack({ top, bottom, align = "right" }: { top: ReactNode; bottom: ReactNode; align?: "left" | "right" }) {
  return (
    <div className={`flex flex-col gap-0.5 whitespace-nowrap ${align === "right" ? "items-end" : "items-start"}`}>
      <span className="tabular-nums">{top}</span>
      <span className="text-[11px] tabular-nums text-ink-3">{bottom}</span>
    </div>
  );
}

function SortHeader({
  column,
  sortKey,
  sortDesc,
  onSort,
}: {
  column: Column;
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
}) {
  if (!column.sorts) return <>{column.label}</>;
  // Single-metric columns keep their own label; merged columns show one sort button per metric.
  const buttons = column.sorts.map((s, i) => {
    const active = s.key === sortKey;
    return (
      <span key={s.key} className="inline-flex items-center">
        {i > 0 && <span className="px-1 text-ink-3/60">·</span>}
        <button
          onClick={() => onSort(s.key)}
          className={`inline-flex items-center gap-0.5 uppercase tracking-wider transition-colors hover:text-ink ${
            active ? "text-ink" : ""
          }`}
        >
          {column.sorts!.length === 1 && column.label !== "Pool" ? column.label : s.label}
          <span className={`text-[9px] text-accent ${active ? "opacity-100" : "opacity-0"}`}>{sortDesc ? "▼" : "▲"}</span>
        </button>
      </span>
    );
  });
  if (column.label === "Pool") {
    return (
      <span className="inline-flex items-center gap-2">
        Pool <span className="text-ink-3/60">·</span> {buttons}
      </span>
    );
  }
  return <span className="inline-flex items-center">{buttons}</span>;
}

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
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {COLUMNS.map((c) => {
              const active = c.sorts?.some((s) => s.key === sortKey);
              return (
                <th
                  key={c.label || "actions"}
                  scope="col"
                  title={c.title}
                  aria-sort={active ? (sortDesc ? "descending" : "ascending") : undefined}
                  className={`sticky top-0 z-10 whitespace-nowrap border-b border-line bg-panel/95 px-2.5 py-3 text-[11px] font-semibold uppercase tracking-wider text-ink-3 backdrop-blur first:pl-4 last:pr-4 ${
                    c.align === "left" ? "text-left" : "text-right"
                  }`}
                >
                  <SortHeader column={c} sortKey={sortKey} sortDesc={sortDesc} onSort={onSort} />
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
                <td
                  className={`border-b border-line/80 py-2.5 pl-4 pr-2.5 ${
                    isSelected ? "shadow-[inset_3px_0_0_var(--color-accent)]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-5 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
                    <TokenAvatar symbol={p.base_symbol} />
                    <div className="min-w-0">
                      <div className="max-w-[11rem] truncate font-medium text-ink" title={p.name}>
                        {p.name}
                      </div>
                      <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-3">
                        <span>Fee {p.base_fee_pct}%</span>
                        <span>·</span>
                        <span title="Umur pool">{fmtAge(p.pool_age_hours)}</span>
                        {p.watched && (
                          <>
                            <span>·</span>
                            <span className="text-ink-2" title="Harga on-chain (poll RPC)">
                              On-chain
                            </span>
                          </>
                        )}
                      </div>
                      {p.flags.length > 0 && (
                        <div className="mt-1">
                          <FlagChips flags={p.flags} max={2} />
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className={CELL}>
                  <div className="flex flex-col items-start gap-1">
                    <PlanBadge plan={plan} />
                    <span
                      className="max-w-[10.5rem] truncate text-[11px] text-ink-3"
                      title={isActivePlan(plan) ? plan.note : plan.reason}
                    >
                      {isActivePlan(plan)
                        ? `${STRATEGY_LABEL[plan.strategy]} ${plan.range_low_pct}% / +${plan.range_high_pct}%`
                        : plan.reason}
                    </span>
                  </div>
                </td>
                <td className={CELL}>
                  <div className="flex flex-col items-start gap-1">
                    <ScoreCell score={p.score} />
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <RegimeBadge regime={p.regime} />
                      {p.market?.adx != null && (
                        <span className="text-[11px] tabular-nums text-ink-3">ADX {p.market.adx.toFixed(0)}</span>
                      )}
                    </span>
                  </div>
                </td>
                <td className={`${CELL} text-right`}>
                  <Stack
                    top={<span className="font-mono text-[13px] text-ink-2">{fmtPrice(p.price)}</span>}
                    bottom={`bin ${p.bin_step} · ${binStepPct(p.bin_step)}`}
                  />
                </td>
                <td className={`${CELL} text-right`}>
                  <Stack top={<Delta value={p.change_pct_1h} />} bottom={`vol ${fmtPct(p.realized_vol_pct_1h)}`} />
                </td>
                <td className={`${CELL} text-right`}>
                  <Stack
                    top={<span className="text-ink">{usdCompact.format(p.tvl)}</span>}
                    bottom={`vol ${usdCompact.format(p.volume_24h)}`}
                  />
                </td>
                <td className={`${CELL} text-right`}>
                  <Stack
                    top={<span className="font-semibold text-ink">{fmtPct(p.fee_for_position_pct_day, 2)}</span>}
                    bottom={`24j ${fmtPct(p.fee_tvl_pct_24h, 2)}`}
                  />
                </td>
                <td className="border-b border-line/80 py-2.5 pl-2.5 pr-4">
                  <div className="flex items-center justify-end gap-1">
                    <Link
                      href={`/pool/${p.address}`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Grafik ${p.name}`}
                      title="Grafik & rekomendasi range"
                      className={ICON_BUTTON}
                    >
                      <CandleIcon />
                    </Link>
                    <a
                      href={`https://meteora.ag/dlmm/${p.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Buka ${p.name} di Meteora`}
                      title="Buka di Meteora"
                      className={ICON_BUTTON}
                    >
                      <ExternalLinkIcon />
                    </a>
                  </div>
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
                    {status === "live"
                      ? "Coba longgarkan filter atau tampilkan pool yang tidak direkomendasikan."
                      : "Data akan muncul otomatis saat koneksi siap."}
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
