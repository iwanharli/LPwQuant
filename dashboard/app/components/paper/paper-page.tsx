"use client";

import { useEffect, useState, type ReactNode } from "react";
import { STRATEGY_LABEL, TIER_META } from "../../lib/flags";
import {
  ENGINE_URL,
  fmtDateTime,
  fmtHours,
  fmtPct,
  fmtPriceExact,
  fmtSignedPct,
  integer,
  usd,
} from "../../lib/format";
import {
  EXIT_REASON_LABELS,
  type EquityPoint,
  type PaperPosition,
  type PaperSummary,
  type TradeStats,
} from "../../lib/paper-types";
import type { Tier } from "../../lib/types";
import TopBar from "../top-bar";
import { ChevronIcon } from "../icons";
import { Delta, StatusDot } from "../ui";
import EquityChart from "./equity-chart";

const REFRESH_MS = 30_000;
const TIERS: Tier[] = ["low", "medium", "high"];

type PaperData = {
  summary: PaperSummary;
  open: PaperPosition[];
  closed: PaperPosition[];
  equity: EquityPoint[];
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function usePaperData() {
  const [data, setData] = useState<PaperData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [summary, open, closed, equity] = await Promise.all([
          getJson<PaperSummary>("/api/paper/summary"),
          getJson<{ positions: PaperPosition[] }>("/api/paper/positions?status=open"),
          getJson<{ positions: PaperPosition[] }>("/api/paper/positions?status=closed&limit=100"),
          getJson<{ points: EquityPoint[] }>("/api/paper/equity?hours=720"),
        ]);
        if (!cancelled) {
          setData({ summary, open: open.positions, closed: closed.positions, equity: equity.points });
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Gagal memuat data");
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return { data, error };
}

function Card({
  title,
  children,
  right,
  collapsible = false,
  collapsedRight,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
  collapsible?: boolean;
  /** Shown in the header instead of `right` while collapsed. */
  collapsedRight?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const header = (
    <>
      <span className="flex items-center gap-2">
        {collapsible && (
          <ChevronIcon className={`text-ink-3 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
        )}
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
      </span>
      {open ? right : (collapsedRight ?? right)}
    </>
  );
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel/90 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`flex w-full items-center justify-between gap-3 bg-raised/20 px-4 py-3 text-left transition-colors hover:bg-raised/40 ${
            open ? "border-b border-line" : ""
          }`}
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">{header}</div>
      )}
      {open && children}
    </section>
  );
}

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint: ReactNode }) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl border border-line bg-panel/90 px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</div>
      <div className="mt-1 truncate text-xs text-ink-3">{hint}</div>
    </div>
  );
}

function TierBadge({ tier }: { tier: Tier }) {
  const meta = TIER_META[tier];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-raised px-2 py-0.5 text-xs font-medium text-ink">
      <StatusDot severity={meta.severity} />
      {meta.label}
    </span>
  );
}

/** Costs shown as a deduction; a zero cost has no minus sign. */
function fmtCost(pct: number | null | undefined): string {
  if (pct == null) return "–";
  return pct < 0.005 ? "0.00%" : `−${pct.toFixed(2)}%`;
}

/** Net PnL with the gross (pre-cost) figure underneath, so the cost drag is visible per row. */
function PnlCell({ net, gross }: { net: number; gross: number | null }) {
  return (
    <div className="flex flex-col items-end">
      <Delta value={net} digits={2} />
      {gross != null && (
        <span className="text-[11px] font-normal text-ink-3" title="Sebelum biaya transaksi, swap, dan price impact">
          kotor {fmtSignedPct(gross, 2)}
        </span>
      )}
    </div>
  );
}

/** Realized PnL of a closed position: USD amount with the percentage of capital underneath. */
function PnlUsdCell({ usd: amount, pct }: { usd: number; pct: number }) {
  const tone = amount > 0 ? "text-up" : amount < 0 ? "text-down" : "text-ink-2";
  return (
    <div className={`flex flex-col items-end tabular-nums ${tone}`}>
      <span className="font-semibold">
        {amount > 0 ? "+" : amount < 0 ? "−" : ""}
        {usd.format(Math.abs(amount))}
      </span>
      <span className="text-[11px]">{fmtSignedPct(pct, 2)}</span>
    </div>
  );
}

function ciText(s: TradeStats): string {
  if (s.ci_low == null || s.ci_high == null) return "–";
  return `[${fmtSignedPct(s.ci_low, 2)}, ${fmtSignedPct(s.ci_high, 2)}]`;
}

function StatsTable({ rows }: { rows: { key: string; label: ReactNode; stats: TradeStats }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm tabular-nums">
        <thead className="text-[11px] uppercase tracking-wider text-ink-3">
          <tr>
            <th className="px-4 py-2.5 text-left font-medium">Grup</th>
            <th className="px-3 py-2.5 text-right font-medium">Trade</th>
            <th className="px-3 py-2.5 text-right font-medium">Win</th>
            <th className="px-3 py-2.5 text-right font-medium" title="Setelah biaya">
              Rata-rata bersih
            </th>
            <th className="px-3 py-2.5 text-right font-medium">95% CI</th>
            <th className="px-3 py-2.5 text-right font-medium">10% terburuk</th>
            <th className="px-3 py-2.5 text-right font-medium">Fee</th>
            <th className="px-3 py-2.5 text-right font-medium">IL</th>
            <th className="px-3 py-2.5 text-right font-medium" title="Transaksi, swap, dan price impact">
              Biaya
            </th>
            <th className="px-4 py-2.5 text-right font-medium">Durasi</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label, stats: s }) => (
            <tr key={key} className="border-t border-line/80 transition-colors hover:bg-hover/50">
              <td className="px-4 py-2.5 text-left">{label}</td>
              <td className="px-3 py-2.5 text-right text-ink">{integer.format(s.trades)}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{s.trades ? fmtPct(s.win_rate_pct) : "–"}</td>
              <td className="px-3 py-2.5 text-right">
                {s.trades ? (
                  <PnlCell net={s.mean_return_pct ?? 0} gross={s.mean_gross_return_pct ?? null} />
                ) : (
                  <span className="text-ink-3">–</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-right text-ink-2">{ciText(s)}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{s.trades ? fmtSignedPct(s.p10_return_pct, 2) : "–"}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{s.trades ? fmtPct(s.mean_fee_pct, 2) : "–"}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{s.trades ? fmtSignedPct(s.mean_il_vs_hodl_pct, 2) : "–"}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{s.trades ? fmtCost(s.mean_cost_pct) : "–"}</td>
              <td className="px-4 py-2.5 text-right text-ink-2">{s.trades ? fmtHours(s.mean_hold_hours ?? 0) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PoolCell({ p }: { p: PaperPosition }) {
  return (
    <div className="min-w-0">
      <a
        href={`https://app.meteora.ag/dlmm/${p.address}`}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-ink hover:underline"
      >
        {p.name}
      </a>
      <div className="text-[11px] text-ink-3">
        Bin {p.bin_step} · {STRATEGY_LABEL[p.strategy]} · {usd.format(p.capital_usd)}
        {p.positions > 1 && ` · ${p.positions} posisi`}
      </div>
    </div>
  );
}

function OpenTable({ positions }: { positions: PaperPosition[] }) {
  if (positions.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-ink-3">
        Belum ada posisi terbuka. Paper trader membuka posisi di siklus engine berikutnya jika ada pool yang lolos.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1160px] text-sm tabular-nums">
        <thead className="text-[11px] uppercase tracking-wider text-ink-3">
          <tr>
            <th className="px-4 py-2.5 text-left font-medium">Pool</th>
            <th className="px-3 py-2.5 text-left font-medium">Tier</th>
            <th className="px-3 py-2.5 text-left font-medium">Masuk</th>
            <th className="px-3 py-2.5 text-right font-medium">Harga masuk → sekarang</th>
            <th className="px-3 py-2.5 text-right font-medium">Min – max price</th>
            <th className="px-3 py-2.5 text-right font-medium">Fee</th>
            <th className="px-3 py-2.5 text-right font-medium">IL</th>
            <th
              className="px-3 py-2.5 text-right font-medium"
              title="Biaya masuk + perkiraan biaya keluar sekarang (transaksi, swap, price impact)"
            >
              Biaya
            </th>
            <th className="px-4 py-2.5 text-right font-medium">PnL bersih</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id} className="border-t border-line/80 transition-colors hover:bg-hover/50">
              <td className="px-4 py-2.5 text-left">
                <PoolCell p={p} />
              </td>
              <td className="px-3 py-2.5 text-left">
                <TierBadge tier={p.tier} />
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-left text-ink-2">
                {fmtDateTime(p.entry_ts)}
                <div className="text-[11px] text-ink-3">{fmtHours(p.hold_hours)} lalu</div>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[13px] text-ink-2">
                {fmtPriceExact(p.entry_price)} → <span className="text-ink">{fmtPriceExact(p.last_price)}</span>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">
                <div className="flex items-center justify-end gap-2 font-mono text-[13px] text-ink-2">
                  <span
                    className="flex items-center gap-1.5 font-sans text-[11px] text-ink-3"
                    title={p.in_range ? "Harga di dalam range" : "Harga di luar range"}
                  >
                    <StatusDot severity={p.in_range ? "good" : "warning"} />
                    {p.in_range ? "in range" : "out"}
                  </span>
                  {fmtPriceExact(p.min_price)} – {fmtPriceExact(p.max_price)}
                </div>
              </td>
              <td className="px-3 py-2.5 text-right text-ink-2">{fmtPct(p.fee_pct, 2)}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{fmtSignedPct(p.il_pct, 2)}</td>
              <td className="px-3 py-2.5 text-right text-ink-2" title={`Rent terkunci ${p.rent_sol.toFixed(4)} SOL (kembali saat tutup)`}>
                {fmtCost(p.cost_pct)}
              </td>
              <td className="px-4 py-2.5 text-right font-semibold">
                <PnlCell net={p.pnl_pct} gross={p.gross_pnl_pct} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClosedTable({ positions }: { positions: PaperPosition[] }) {
  if (positions.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-ink-3">Belum ada posisi yang ditutup.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1060px] text-sm tabular-nums">
        <thead className="text-[11px] uppercase tracking-wider text-ink-3">
          <tr>
            <th className="px-4 py-2.5 text-left font-medium">Pool</th>
            <th className="px-3 py-2.5 text-left font-medium">Tier</th>
            <th className="px-3 py-2.5 text-left font-medium">Masuk</th>
            <th className="px-3 py-2.5 text-left font-medium">Keluar</th>
            <th className="px-3 py-2.5 text-right font-medium">Durasi</th>
            <th className="px-3 py-2.5 text-right font-medium">Fee</th>
            <th className="px-3 py-2.5 text-right font-medium">IL</th>
            <th className="px-3 py-2.5 text-right font-medium" title="Transaksi, swap, dan price impact">
              Biaya
            </th>
            <th className="px-4 py-2.5 text-right font-medium" title="Setelah biaya, dalam USD dan persen modal">
              PnL
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id} className="border-t border-line/80 transition-colors hover:bg-hover/50">
              <td className="px-4 py-2.5 text-left">
                <PoolCell p={p} />
              </td>
              <td className="px-3 py-2.5 text-left">
                <TierBadge tier={p.tier} />
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-left text-ink-2">{fmtDateTime(p.entry_ts)}</td>
              <td className="whitespace-nowrap px-3 py-2.5 text-left text-ink-2">
                {p.exit_ts ? fmtDateTime(p.exit_ts) : "–"}
                <div className="text-[11px] text-ink-3">{EXIT_REASON_LABELS[p.exit_reason ?? ""] ?? p.exit_reason}</div>
              </td>
              <td className="px-3 py-2.5 text-right text-ink-2">{fmtHours(p.hold_hours)}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{fmtPct(p.fee_pct, 2)}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{fmtSignedPct(p.il_pct, 2)}</td>
              <td className="px-3 py-2.5 text-right text-ink-2">{fmtCost(p.cost_pct)}</td>
              <td className="px-4 py-2.5 text-right">
                <PnlUsdCell usd={(p.capital_usd * p.pnl_pct) / 100} pct={p.pnl_pct} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultsCard({ summary: s }: { summary: PaperSummary | undefined }) {
  const [tab, setTab] = useState<"tier" | "strategy">("tier");
  const strategies = s ? Object.entries(s.by_strategy) : [];
  const tabs = [
    { id: "tier" as const, label: "Per tier" },
    { id: "strategy" as const, label: "Per strategi" },
  ];
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel/90 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink">Hasil trading</h2>
          <div role="tablist" className="flex rounded-lg border border-line bg-bg/80 p-1 shadow-inner shadow-black/20">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  tab === t.id ? "bg-raised text-ink shadow-sm shadow-black/25" : "text-ink-3 hover:bg-raised/50 hover:text-ink-2"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <span className="text-xs text-ink-3">Posisi yang sudah ditutup · CI bootstrap per jam entry</span>
      </div>

      {!s ? (
        <p className="px-4 py-8 text-sm text-ink-3">Memuat…</p>
      ) : tab === "tier" ? (
        <StatsTable
          rows={TIERS.map((t) => ({ key: t, label: <TierBadge tier={t} />, stats: s.by_tier[t] ?? { trades: 0 } }))}
        />
      ) : strategies.length > 0 ? (
        <StatsTable
          rows={strategies.map(([k, stats]) => ({
            key: k,
            label: <span className="text-ink">{STRATEGY_LABEL[k as keyof typeof STRATEGY_LABEL] ?? k}</span>,
            stats,
          }))}
        />
      ) : (
        <p className="px-4 py-10 text-center text-sm text-ink-3">Belum ada posisi yang ditutup.</p>
      )}

      {s && s.closed_count > 0 && s.closed_count < 30 && (
        <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
          Baru {s.closed_count} trade. Kesimpulan statistik butuh puluhan sampai ratusan trade per grup (±2–4 minggu).
        </p>
      )}
    </section>
  );
}

function PositionsCard({ open, closed }: { open: PaperPosition[]; closed: PaperPosition[] }) {
  const [tab, setTab] = useState<"open" | "closed">("open");
  const tabs = [
    { id: "open" as const, label: "Terbuka", count: open.length },
    { id: "closed" as const, label: "Ditutup", count: closed.length },
  ];
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel/90 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink">Posisi</h2>
          <div role="tablist" className="flex rounded-lg border border-line bg-bg/80 p-1 shadow-inner shadow-black/20">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  tab === t.id ? "bg-raised text-ink shadow-sm shadow-black/25" : "text-ink-3 hover:bg-raised/50 hover:text-ink-2"
                }`}
              >
                {t.label}
                <span className="tabular-nums text-ink-3">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
        <span className="text-xs text-ink-3">
          {tab === "open" ? "Diperbarui tiap siklus engine" : "100 posisi terakhir"}
        </span>
      </div>
      {tab === "open" ? <OpenTable positions={open} /> : <ClosedTable positions={closed} />}
    </section>
  );
}

export default function PaperPage() {
  const { data, error } = usePaperData();
  const s = data?.summary;
  const totalPnl = s ? s.equity_usd - s.start_equity_usd : 0;
  const totalPct = s ? (totalPnl / s.start_equity_usd) * 100 : 0;

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:max-w-[1680px]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Paper trading</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-3">
            Posisi LP virtual dibuka otomatis dari rencana posisi live, maksimal{" "}
            {s ? s.config.max_open_per_tier : "–"} posisi per tier dan minimal{" "}
            {s ? usd.format(s.risk.min_position_usd) : "–"} per posisi, lalu ditutup dengan aturan exit yang sama seperti
            backtest. Posisi baru berhenti dibuka kalau equity turun {s?.risk.max_drawdown_pct ?? "–"}% dari puncaknya. Tidak ada transaksi on-chain. PnL dihitung dalam token quote pool, jadi pergerakan harga SOL
            sendiri tidak ikut.
          </p>
          </div>
          <div className="hidden rounded-lg border border-line bg-panel/70 px-3 py-2 text-right shadow-sm shadow-black/20 lg:block">
            <div className="text-[11px] uppercase tracking-wider text-ink-3">Portfolio</div>
            <div className="text-sm font-semibold text-ink">{s ? usd.format(s.equity_usd) : "Menunggu data"}</div>
          </div>
        </div>

        {error && (
          <p className="flex items-center gap-2 rounded-xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
            <StatusDot severity="critical" /> {error}. Pastikan engine berjalan di {ENGINE_URL}.
          </p>
        )}
        {s?.risk.entries_paused && (
          <p className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
            <StatusDot severity="warning" /> Posisi baru dihentikan: equity {fmtPct(s.risk.drawdown_pct, 1)} di bawah puncak{" "}
            {usd.format(s.risk.peak_equity_usd)} (batas {s.risk.max_drawdown_pct}%). Posisi terbuka tetap dikelola.
          </p>
        )}
        {s && !s.enabled && (
          <p className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
            <StatusDot severity="warning" /> Paper trading nonaktif (PAPER_ENABLED=false).
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
          <Tile
            label="Equity virtual"
            value={s ? usd.format(s.equity_usd) : "–"}
            hint={s ? `${totalPnl >= 0 ? "+" : ""}${usd.format(totalPnl)} (${fmtSignedPct(totalPct, 2)}) dari ${usd.format(s.start_equity_usd)}` : "–"}
          />
          <Tile
            label="PnL terealisasi (bersih)"
            value={s ? usd.format(s.realized_usd) : "–"}
            hint={
              s ? `${s.closed_count} posisi ditutup · biaya ${usd.format(s.costs.closed_cost_usd)}` : "–"
            }
          />
          <Tile
            label="PnL belum terealisasi (bersih)"
            value={s ? usd.format(s.unrealized_usd) : "–"}
            hint={
              s
                ? `${s.open_count} terbuka · biaya ${usd.format(s.costs.open_cost_usd)} · rent ${s.costs.rent_locked_sol.toFixed(2)} SOL`
                : "–"
            }
          />
          <Tile
            label="Win rate"
            value={s?.overall.trades ? fmtPct(s.overall.win_rate_pct) : "–"}
            hint={s?.started_at ? `Sejak ${fmtDateTime(s.started_at)} WIB` : "Belum ada trade"}
          />
          <Tile
            label="Rata-rata return / trade"
            value={s?.overall.trades ? fmtSignedPct(s.overall.mean_return_pct, 2) : "–"}
            hint={s?.overall.trades ? `95% CI ${ciText(s.overall)}` : "Butuh posisi yang sudah ditutup"}
          />
        </div>

        <Card
          title="Kurva equity"
          collapsible
          right={<span className="text-xs text-ink-3">30 hari terakhir</span>}
          collapsedRight={
            s ? (
              <span className="flex items-center gap-3 text-xs tabular-nums">
                <span className="text-ink">{usd.format(s.equity_usd)}</span>
                <Delta value={totalPct} digits={2} />
              </span>
            ) : undefined
          }
        >
          <div className="px-2 py-3 sm:px-4">
            <EquityChart points={data?.equity ?? []} start={s?.start_equity_usd ?? 0} />
          </div>
        </Card>

        <ResultsCard summary={s} />

        <PositionsCard open={data?.open ?? []} closed={data?.closed ?? []} />

        <p className="pb-2 text-center text-xs leading-5 text-ink-3">
          Simulasi: likuiditas rata di semua bin, fee dari fee/TVL 1 jam pool.
          {s?.costs.enabled ? (
            <>
              {" "}
              Biaya: {s.costs.txs_per_position} transaksi per posisi × {s.costs.tx_cost_sol} SOL, swap (fee pool + price
              impact ×{s.costs.impact_multiplier}) saat masuk dan keluar, rent posisi {s.costs.position_rent_sol.toFixed(4)}{" "}
              SOL dikunci lalu kembali
              {s.costs.new_bin_array_share > 0
                ? `, rent bin array baru ${Math.round(s.costs.new_bin_array_share * 100)}%`
                : ", bin array diasumsikan sudah ada"}
              .
            </>
          ) : (
            " Biaya transaksi dan slippage tidak dihitung (PAPER_COSTS_ENABLED=false)."
          )}{" "}
          Bukan saran finansial.
        </p>
      </main>
    </div>
  );
}
