"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../../lib/auto-refresh";
import { EXIT_TONE } from "../../lib/exit-status";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../../lib/format";
import { STRATEGY_NOTES } from "../../lib/strategy-notes";
import { useUrlState } from "../../lib/url-state";
import { Kpi, StrategyNotes } from "../panda-page";
import { SkeletonStrip, SkeletonTable, SkeletonTabs } from "../skeleton";

type Run = {
  id: number;
  wallet: string;
  position: string;
  pool: string;
  pair: string;
  status: "open" | "closed";
  size_usd: number;
  delay_s: number | null;
  entry_pnl_pct: number | null;
  last_pnl_pct: number | null;
  exit_pnl_pct: number | null;
  result_pct: number;
  pnl_usd: number;
  costs_usd: number | null;
  their_deposit_usd: number | null;
  opened_at: number;
  closed_at: number | null;
  checked_at: number | null;
};
type Leader = { wallet: string; pnl_7d_usd: number; win_rate: number | null; hold_median_h: number | null; deposit_median_usd: number | null; top_pairs: string[] };
type Report = {
  params: { follow: number; size_usd: number; tick_s: number; fresh_min: number; exit_swap_pct: number };
  wallets: Leader[];
  counts: { open: number; closed: number };
  pnl_usd: number;
  win_rate: number | null;
  runs: Run[];
};

const money = (n: number | null | undefined) => (n == null ? "–" : `${n >= 0 ? "+" : "−"}${usd.format(Math.abs(n))}`);
const tone = (n: number | null | undefined) => (n == null ? "text-ink-3" : n > 0.005 ? "text-emerald-300" : n < -0.005 ? "text-rose-300" : "text-ink-2");
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const span = (ms: number) => {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)} mnt` : h < 48 ? `${fmtNum(h, 1)} jam` : `${fmtNum(h / 24, 1)} hari`;
};
const VIEWS = ["berjalan", "selesai", "wallet", "aturan", "catatan"] as const;
type View = (typeof VIEWS)[number];

function Table({ runs, empty }: { runs: Run[]; empty: string }) {
  if (runs.length === 0) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center text-sm text-ink-3">{empty}</p>;
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm tabular-nums">
          <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 text-left font-medium">Pool</th>
              <th className="px-3 py-2.5 text-left font-medium">Status</th>
              <th className="px-3 py-2.5 text-left font-medium">Ditiru dari</th>
              <th className="px-3 py-2.5 text-right font-medium" title="Berapa lama setelah wallet membuka posisi, tiruan baru bisa masuk">Jeda</th>
              <th className="px-3 py-2.5 text-right font-medium" title="PnL wallet itu saat ditiru, lalu saat ditutup">PnL wallet</th>
              <th className="px-3 py-2.5 text-right font-medium">Hasil tiruan</th>
              <th className="px-3 py-2.5 text-right font-medium">Lama</th>
              <th className="px-4 py-2.5 text-right font-medium">Waktu</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-b-0">
                <td className="px-4 py-2.5">
                  <Link href={`/pool/${r.pool}`} className="font-medium text-ink hover:text-accent">
                    {r.pair}
                  </Link>
                  <div className="text-[11px] text-ink-3">
                    modal {usd.format(r.size_usd)}
                    {r.their_deposit_usd ? ` · wallet ${usd.format(r.their_deposit_usd)}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "open" ? EXIT_TONE.running : EXIT_TONE.planned}`}>
                    {r.status === "open" ? "Berjalan" : "Ditutup bersama wallet"}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <a href={`https://solscan.io/account/${r.wallet}`} target="_blank" rel="noreferrer" className="font-mono text-ink-2 hover:text-accent">
                    {short(r.wallet)}
                  </a>
                </td>
                <td className="px-3 py-2.5 text-right text-ink-2">{r.delay_s == null ? "–" : span(r.delay_s * 1000)}</td>
                <td className="px-3 py-2.5 text-right text-[12px] text-ink-3">
                  {fmtNum(r.entry_pnl_pct ?? 0, 1)}% → {fmtNum((r.status === "open" ? r.last_pnl_pct : r.exit_pnl_pct) ?? 0, 1)}%
                </td>
                <td className={`px-3 py-2.5 text-right font-semibold ${tone(r.pnl_usd)}`}>
                  {money(r.pnl_usd)}
                  <div className="text-[11px] font-normal opacity-80">
                    {r.result_pct >= 0 ? "+" : ""}
                    {fmtNum(r.result_pct, 2)}%
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right text-ink-2">{span((r.closed_at ?? r.checked_at ?? r.opened_at) - r.opened_at)}</td>
                <td className="px-4 py-2.5 text-right text-[11px] text-ink-3">{fmtDateTime(r.closed_at ?? r.opened_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function CopyPaper() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    fetch(`${ENGINE_URL}/api/paper/copy`)
      .then((x) => (x.ok ? x.json() : Promise.reject(x.status)))
      .then((b: Report) => {
        setR(b);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  useAutoRefresh(load, 30_000);
  useEffect(load, [load]);
  const [view, setView] = useUrlState<View>("copy", "berjalan", VIEWS);

  if (!r && error) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>;
  if (!r)
    return (
      <>
        <SkeletonStrip count={4} />
        <SkeletonTabs count={5} />
        <SkeletonTable rows={5} columns={7} title={false} />
      </>
    );
  const p = r.params;
  const running = r.runs.filter((x) => x.status === "open");
  const done = r.runs.filter((x) => x.status === "closed");
  const avg = done.length ? done.reduce((n, x) => n + x.result_pct, 0) / done.length : null;

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
        <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
          <Kpi label="Hasil bersih" value={done.length ? money(r.pnl_usd) : "–"} cls={done.length ? tone(r.pnl_usd) : undefined} hint={`${done.length} tiruan selesai`} />
          <Kpi label="Rata-rata per tiruan" value={avg == null ? "–" : `${avg >= 0 ? "+" : ""}${fmtNum(avg, 2)}%`} cls={tone(avg)} hint="setelah jeda, sebelum biaya" />
          <Kpi label="Win rate" value={r.win_rate == null ? "–" : `${fmtNum(r.win_rate * 100, 0)}%`} hint={`${running.length} tiruan berjalan`} />
          <Kpi label="Modal per posisi" value={usd.format(p.size_usd)} hint={`meniru ${r.wallets.length} wallet`} />
        </div>
      </section>

      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Tampilan copy LP">
        {(
          [
            { value: "berjalan", label: `Berjalan (${running.length})` },
            { value: "selesai", label: `Selesai (${done.length})` },
            { value: "wallet", label: `Wallet diikuti (${r.wallets.length})` },
            { value: "aturan", label: "Aturan" },
            { value: "catatan", label: "Catatan" },
          ] as const
        ).map((o) => (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={view === o.value}
            onClick={() => setView(o.value)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              view === o.value ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      {view === "berjalan" && (
        <Table runs={running} empty={`Belum ada tiruan berjalan. Dicek tiap ${p.tick_s / 60} menit: menunggu wallet yang diikuti membuka posisi baru.`} />
      )}
      {view === "selesai" && <Table runs={done} empty="Belum ada tiruan yang selesai." />}
      {view === "wallet" &&
        (r.wallets.length === 0 ? (
          <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center text-sm text-ink-3">
            Belum ada wallet yang layak diikuti. Daftar diambil dari halaman LP teratas.
          </p>
        ) : (
          <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
            <ul className="divide-y divide-white/[0.05]">
              {r.wallets.map((w) => (
                <li key={w.wallet} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 text-sm tabular-nums">
                  <a href={`https://solscan.io/account/${w.wallet}`} target="_blank" rel="noreferrer" className="font-mono font-medium text-ink hover:text-accent">
                    {short(w.wallet)}
                  </a>
                  <span className={tone(w.pnl_7d_usd)}>7 hari {money(w.pnl_7d_usd)}</span>
                  <span className="text-ink-2">win rate {w.win_rate == null ? "–" : `${fmtNum(w.win_rate * 100, 0)}%`}</span>
                  <span className="text-ink-2">pegang {w.hold_median_h == null ? "–" : span(w.hold_median_h * 3_600_000)}</span>
                  <span className="text-ink-2">modal {w.deposit_median_usd == null ? "–" : usd.format(w.deposit_median_usd)}</span>
                  <span className="text-xs text-ink-3">{w.top_pairs.join(" · ")}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {view === "aturan" && (
        <section className="grid gap-4 rounded-2xl border border-white/[0.06] bg-panel p-4 md:grid-cols-2">
          {[
            {
              title: "Masuk",
              items: [
                `Wallet yang diikuti: ${p.follow} teratas di LP teratas yang layak diikuti, diurutkan hasil 7 hari; daftarnya ikut berubah tiap 6 jam.`,
                `Posisi wallet dicek tiap ${p.tick_s / 60} menit. Posisi baru (dibuka < ${p.fresh_min} menit lalu) langsung ditiru dengan ${usd.format(p.size_usd)}.`,
                "Tiruan mulai saat posisi terlihat: jedanya nyata, dan hasil wallet sebelum jeda itu tidak ikut dihitung.",
                "Posisi yang sudah terbuka saat wallet pertama kali diikuti tidak ditiru di tengah jalan.",
              ],
            },
            {
              title: "Keluar",
              items: [
                "Tiruan ditutup saat wallet menutup posisinya, dengan hasil akhir wallet untuk posisi itu.",
                "Hasil tiruan = (1 + PnL akhir wallet) ÷ (1 + PnL wallet saat ditiru) − 1, dikali modal.",
                `Biaya tiruan: fee jaringan dan jual sisa token ${p.exit_swap_pct}% dari posisi. Sewa bin array dianggap nol karena sudah dibuka wallet aslinya.`,
              ],
            },
          ].map((b) => (
            <div key={b.title}>
              <h3 className="text-base font-semibold text-ink">{b.title}</h3>
              <ul className="mt-2 space-y-2 text-sm leading-6 text-ink-2">
                {b.items.map((t) => (
                  <li key={t} className="flex gap-2">
                    <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {view === "catatan" && <StrategyNotes note={STRATEGY_NOTES.copy} />}
    </>
  );
}
