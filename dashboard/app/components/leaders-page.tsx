"use client";

import { useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../lib/auto-refresh";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../lib/format";
import PageHeader from "./page-header";
import { SkeletonStrip, SkeletonTable } from "./skeleton";
import TopBar from "./top-bar";

type Leader = {
  wallet: string;
  lifetime_pnl_usd: number;
  lifetime_closed: number;
  pools_total: number;
  sample: number;
  pnl_usd: number;
  wins: number;
  win_rate: number | null;
  median_usd: number | null;
  median_pct: number | null;
  without_best3_usd: number | null;
  worst_usd: number | null;
  fees_usd: number;
  hold_median_h: number | null;
  deposit_median_usd: number | null;
  pnl_7d_usd: number;
  positions_7d: number;
  last_closed_at: number | null;
  top_pairs: string[];
  meets: boolean;
};
type Report = {
  updated_at: number | null;
  criteria: { min_closed: number; min_hold_h: number; min_deposit: number; max_deposit: number; active_days: number };
  leaders: Leader[];
};

const money = (n: number | null | undefined) => (n == null ? "–" : `${n >= 0 ? "+" : "−"}${usd.format(Math.abs(n))}`);
const tone = (n: number | null | undefined) => (n == null ? "text-ink-3" : n > 0.005 ? "text-emerald-300" : n < -0.005 ? "text-rose-300" : "text-ink-2");
const span = (h: number | null) => (h == null ? "–" : h < 1 ? `${Math.round(h * 60)} mnt` : h < 48 ? `${fmtNum(h, 1)} jam` : `${fmtNum(h / 24, 1)} hari`);
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

export default function LeadersPage() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const [onlyGood, setOnlyGood] = useState(true);
  const load = useCallback(() => {
    fetch(`${ENGINE_URL}/api/lp-leaders`)
      .then((x) => (x.ok ? x.json() : Promise.reject(x.status)))
      .then((b: Report) => {
        setR(b);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  useAutoRefresh(load, 5 * 60_000);
  useEffect(load, [load]);

  const leaders = r?.leaders ?? [];
  const good = leaders.filter((l) => l.meets);
  const shown = onlyGood ? good : leaders;
  const c = r?.criteria;

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader title="LP" accent="teratas" subtitle="Wallet LP Meteora yang konsisten untung, dari pool-pool teramai di screener." />

        {!r && !error && (
          <>
            <SkeletonStrip count={4} />
            <SkeletonTable rows={8} columns={9} />
          </>
        )}
        {!r && error && <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>}

        {r && (
          <>
            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
              <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
                <Kpi label="Wallet dinilai" value={String(leaders.length)} hint="punya posisi di 40 pool teramai, ≥30 posisi, untung" />
                <Kpi label="Layak diikuti" value={String(good.length)} cls={good.length ? "text-emerald-300" : "text-ink-2"} hint="memenuhi semua kriteria" />
                <Kpi
                  label="Terbaik 7 hari"
                  value={good[0] ? money(good[0].pnl_7d_usd) : "–"}
                  cls={tone(good[0]?.pnl_7d_usd)}
                  hint={good[0] ? short(good[0].wallet) : undefined}
                />
                <Kpi label="Diperbarui" value={r.updated_at ? fmtDateTime(r.updated_at) : "belum"} hint="dihitung ulang tiap 6 jam" />
              </div>
            </section>

            {c && (
              <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3 text-sm leading-6 text-ink-3">
                <span className="font-medium text-ink-2">Layak diikuti</span> bila: ≥{c.min_closed} posisi selesai, median hasil per posisi dan hasil tanpa 3
                terbaik sama-sama positif, rata-rata dipegang ≥{c.min_hold_h * 60} menit (masih bisa ditiru), modal per posisi {usd.format(c.min_deposit)}–
                {usd.format(c.max_deposit)}, dan masih aktif {c.active_days} hari terakhir. Hasil = PnL Meteora per posisi (di dalam posisi saja), dari
                25 pool terakhir tiap wallet.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {[
                { v: true, label: `Layak diikuti (${good.length})` },
                { v: false, label: `Semua (${leaders.length})` },
              ].map((o) => (
                <button
                  key={String(o.v)}
                  type="button"
                  aria-pressed={onlyGood === o.v}
                  onClick={() => setOnlyGood(o.v)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    onlyGood === o.v ? "border-accent/70 bg-accent/10 text-ink" : "border-line bg-bg/40 text-ink-2 hover:text-ink"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {shown.length === 0 ? (
              <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center text-sm text-ink-3">
                {leaders.length === 0 ? "Pengumpulan pertama sedang berjalan (±15 menit)." : "Belum ada wallet yang memenuhi semua kriteria."}
              </p>
            ) : (
              <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1100px] text-sm tabular-nums">
                    <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                      <tr className="border-b border-line">
                        <th className="px-4 py-2.5 text-left font-medium">Wallet</th>
                        <th className="px-3 py-2.5 text-right font-medium">Hasil 7 hari</th>
                        <th className="px-3 py-2.5 text-right font-medium">Hasil sampel</th>
                        <th className="px-3 py-2.5 text-right font-medium" title="Posisi yang untung dibagi semua posisi di sampel">Win rate</th>
                        <th className="px-3 py-2.5 text-right font-medium">Median / posisi</th>
                        <th className="px-3 py-2.5 text-right font-medium">Tanpa 3 terbaik</th>
                        <th className="px-3 py-2.5 text-right font-medium">Lama pegang</th>
                        <th className="px-3 py-2.5 text-right font-medium">Modal</th>
                        <th className="px-4 py-2.5 text-left font-medium">Pool favorit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((l) => (
                        <tr key={l.wallet} className="border-b border-line/60 last:border-b-0 hover:bg-white/[0.02]">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <a
                                href={`https://solscan.io/account/${l.wallet}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono font-medium text-ink hover:text-accent"
                              >
                                {short(l.wallet)}
                              </a>
                              {l.meets && <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">Layak</span>}
                            </div>
                            <div className="text-[11px] text-ink-3">
                              seumur hidup {money(l.lifetime_pnl_usd)} · {l.lifetime_closed} posisi
                              {l.last_closed_at ? ` · terakhir ${fmtDateTime(l.last_closed_at)}` : ""}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <div className={`font-semibold ${tone(l.pnl_7d_usd)}`}>{money(l.pnl_7d_usd)}</div>
                            <div className="text-[11px] text-ink-3">{l.positions_7d} posisi</div>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <div className={tone(l.pnl_usd)}>{money(l.pnl_usd)}</div>
                            <div className="text-[11px] text-ink-3">{l.sample} posisi</div>
                          </td>
                          <td className={`px-3 py-3 text-right ${l.win_rate == null ? "text-ink-3" : l.win_rate >= 0.5 ? "text-emerald-300" : "text-rose-300"}`}>
                            <div className="font-semibold">{l.win_rate == null ? "–" : `${fmtNum(l.win_rate * 100, 0)}%`}</div>
                            <div className="text-[11px] opacity-80">{l.sample ? `${l.wins} dari ${l.sample} posisi` : ""}</div>
                          </td>
                          <td className={`px-3 py-3 text-right ${tone(l.median_usd)}`}>
                            {money(l.median_usd)}
                            <div className="text-[11px] opacity-80">{l.median_pct == null ? "" : `${fmtNum(l.median_pct, 1)}%`}</div>
                          </td>
                          <td className={`px-3 py-3 text-right ${tone(l.without_best3_usd)}`}>{money(l.without_best3_usd)}</td>
                          <td className="px-3 py-3 text-right text-ink-2">{span(l.hold_median_h)}</td>
                          <td className="px-3 py-3 text-right text-ink-2">{l.deposit_median_usd == null ? "–" : usd.format(l.deposit_median_usd)}</td>
                          <td className="px-4 py-3 text-xs text-ink-2">{l.top_pairs.join(" · ") || "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
