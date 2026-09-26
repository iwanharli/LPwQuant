"use client";

import { useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../../lib/auto-refresh";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../../lib/format";
import { useUrlState } from "../../lib/url-state";
import PageHeader from "../page-header";
import PandaPage from "../panda-page";
import { SkeletonBox, SkeletonStrip, SkeletonTable } from "../skeleton";
import TopBar from "../top-bar";
import PaperPage from "./paper-page";
import { PROFILE_COLORS } from "../../lib/paper-types";
import SolGrid from "./sol-grid";

type Verdict = "viable" | "luck" | "loss" | "data";
type Tab = "ringkasan" | "lp" | "panda" | "sol";
const TABS = ["ringkasan", "lp", "panda", "sol"] as const;

type Strategy = {
  key: string;
  label: string;
  tab: Exclude<Tab, "ringkasan">;
  profile: string | null;
  note: string;
  closed: number;
  open: number;
  started_at: number | null;
  pnl_usd: number;
  capital_usd: number;
  return_pct: number | null;
  avg_size_usd: number | null;
  median_usd: number | null;
  without_best_usd: number | null;
  without_best3_usd: number | null;
  win_rate: number | null;
  wins?: number;
  worst_usd?: number | null;
  worst_pct?: number | null;
  pnl_7d_usd?: number | null;
  passing?: number | null;
  odd_fee_count?: number;
  pnl_without_odd_usd?: number | null;
  positions_per_day?: number | null;
  avg_hold_hours?: number | null;
  total_hold_hours?: number | null;
  verdict: Verdict;
};
type Overview = { min_closed: number; strategies: Strategy[] };

const TAB_LABEL: Record<Tab, string> = {
  ringkasan: "Ringkasan",
  lp: "Profil LP",
  panda: "Panda",
  sol: "Grid SOL-USDC",
};
const TAB_SUBTITLE: Record<Tab, string> = {
  ringkasan: "Semua uji paper dengan ukuran yang sama: hasil, median, dan hasil tanpa trade terbaik.",
  lp: "LP virtual otomatis dari rencana screener, satu portofolio per profil risiko.",
  panda: "Seleksi ketat, range lebar satu sisi, keluar di pantulan pertama.",
  sol: "Limit order beli-jual berulang di SOL-USDC: tanpa risiko rug, untung kecil tapi sering.",
};

const VERDICT: Record<Verdict, { label: string; cls: string; hint: string }> = {
  viable: {
    label: "Layak diuji nyata",
    cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    hint: "Median dan hasil tanpa 3 trade terbaik sama-sama positif",
  },
  luck: {
    label: "Bergantung keberuntungan",
    cls: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    hint: "Total positif, tapi median atau hasil tanpa 3 terbaik negatif",
  },
  loss: { label: "Rugi", cls: "border-rose-400/30 bg-rose-400/10 text-rose-300", hint: "Total hasil negatif" },
  data: { label: "Belum cukup data", cls: "border-white/[0.1] bg-white/[0.04] text-ink-3", hint: "" },
};
const VERDICT_ORDER: Record<Verdict, number> = { viable: 0, luck: 1, loss: 2, data: 3 };

const span = (h: number) => (h < 1 ? `${Math.round(h * 60)} mnt` : h < 48 ? `${fmtNum(h, 1)} jam` : `${fmtNum(h / 24, 1)} hari`);
const tone = (n: number | null | undefined) => (n == null ? "text-ink-3" : n > 0 ? "text-emerald-300" : n < 0 ? "text-rose-300" : "text-ink-2");
const money = (n: number | null | undefined) => (n == null ? "–" : `${n >= 0 ? "+" : "−"}${usd.format(Math.abs(n))}`);
const pct = (n: number | null | undefined, d = 1) => (n == null ? "–" : `${n >= 0 ? "+" : "−"}${fmtNum(Math.abs(n), d)}%`);

function useOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    fetch(`${ENGINE_URL}/api/paper/overview`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((b: Overview) => {
        setData(b);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  useAutoRefresh(load, 60_000);
  useEffect(load, [load]); // the hook's timer only starts the steady cadence
  return { data, error };
}

function Tile({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1 truncate text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

function Summary({ data, error, onOpen }: { data: Overview | null; error: boolean; onOpen: (s: Strategy) => void }) {
  if (!data && error) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>;
  if (!data)
    return (
      <>
        <SkeletonStrip count={4} />
        <SkeletonTable rows={5} columns={8} />
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <SkeletonBox key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      </>
    );

  const rows = [...data.strategies].sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.return_pct ?? -1e9) - (a.return_pct ?? -1e9),
  );
  const closed = rows.reduce((n, s) => n + s.closed, 0);
  const open = rows.reduce((n, s) => n + s.open, 0);
  const viable = rows.filter((s) => s.verdict === "viable");
  const ranked = rows.filter((s) => s.verdict !== "data");
  const best = ranked.length ? ranked.reduce((a, b) => ((b.return_pct ?? -1e9) > (a.return_pct ?? -1e9) ? b : a)) : null;

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
        <div className="grid grid-cols-2 gap-px bg-line/40 lg:grid-cols-4">
          <Tile label="Strategi diuji" value={String(rows.length)} hint={`${open} posisi masih berjalan`} />
          <Tile label="Trade selesai" value={fmtNum(closed)} hint={`minimal ${data.min_closed} per strategi untuk dinilai`} />
          <Tile
            label="Layak diuji nyata"
            value={viable.length ? viable.map((s) => s.label).join(", ") : "Belum ada"}
            cls={viable.length ? "text-emerald-300" : "text-ink-2"}
            hint="median dan tanpa 3 terbaik positif"
          />
          <Tile
            label="Hasil terbaik per modal"
            value={best ? `${best.label} ${pct(best.return_pct)}` : "–"}
            cls={tone(best?.return_pct)}
            hint="dari strategi yang datanya cukup"
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Perbandingan strategi</h2>
          <p className="text-xs text-ink-3">Klik baris untuk membuka detailnya</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-sm tabular-nums">
            <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 text-left font-medium">Strategi</th>
                <th className="px-3 py-2.5 text-left font-medium">Kesimpulan</th>
                <th className="px-3 py-2.5 text-right font-medium">Hasil</th>
                <th className="px-3 py-2.5 text-right font-medium" title="Posisi aktif / pool yang lolos seleksi sekarang (Grid: level memegang SOL / jumlah level)">
                  Aktif / lolos
                </th>
                <th className="px-3 py-2.5 text-right font-medium">Trade</th>
                <th className="px-3 py-2.5 text-right font-medium">Untung</th>
                <th className="px-3 py-2.5 text-right font-medium" title="Hasil posisi yang ditutup dalam 7 hari terakhir">Hasil 7 hari</th>
                <th className="px-3 py-2.5 text-right font-medium" title="Rata-rata posisi yang dibuka per hari sejak strategi mulai">Posisi / hari</th>
                <th className="px-4 py-2.5 text-right font-medium" title="Rata-rata lama satu posisi dibuka sampai ditutup, dan total semua posisi">
                  Lama posisi
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const v = VERDICT[s.verdict];
                const kind = s.tab === "sol" ? "Order" : "LP";
                return (
                  <tr
                    key={s.key}
                    onClick={() => onOpen(s)}
                    className="cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-white/[0.025]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-medium text-ink">
                        {s.label}
                        <span
                          className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${
                            kind === "LP" ? "bg-accent/15 text-accent" : "bg-sky-400/15 text-sky-300"
                          }`}
                        >
                          {kind}
                        </span>
                      </div>
                      <div className="text-[11px] text-ink-3">{s.started_at ? `sejak ${fmtDateTime(s.started_at)}` : "belum mulai"}</div>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        title={`${s.verdict === "data" ? `Butuh ${data.min_closed} trade selesai untuk dinilai` : v.hint}${
                          s.without_best3_usd != null ? ` · tanpa 3 trade terbaik: ${money(s.without_best3_usd)}` : ""
                        }${s.worst_usd != null && s.worst_usd < 0 ? ` · rugi terbesar: ${money(s.worst_usd)}` : ""}`}
                        className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${v.cls}`}
                      >
                        {s.verdict === "data" ? `${v.label} (${s.closed}/${data.min_closed})` : v.label}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className={`font-semibold ${tone(s.closed ? s.pnl_usd : null)}`}>{s.closed ? money(s.pnl_usd) : "–"}</div>
                      <div className={`text-[11px] ${tone(s.return_pct)}`}>{s.return_pct == null ? "" : `${pct(s.return_pct)} dari modal`}</div>
                      {!!s.odd_fee_count && s.pnl_without_odd_usd != null && (
                        <div
                          className="mt-0.5 text-[11px] text-amber-300"
                          title="Posisi dengan fee lebih dari 3% modal per jam: bisa lonjakan sesaat yang jarang terulang, atau kesalahan data"
                        >
                          ⚠ tanpa {s.odd_fee_count} fee tak wajar: {money(s.pnl_without_odd_usd)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="font-medium text-ink">
                        {s.open}/{s.passing ?? "–"}
                      </div>
                      <div className="text-[11px] text-ink-3">{s.tab === "sol" ? "level pegang SOL" : "aktif / lolos"}</div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="text-ink-2">{s.closed} selesai</div>
                      <div className="text-[11px] text-ink-3">{s.open} berjalan</div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className={s.win_rate == null ? "text-ink-2" : s.win_rate >= 0.5 ? "text-emerald-300" : "text-rose-300"}>
                        {s.closed ? `${s.wins ?? Math.round((s.win_rate ?? 0) * s.closed)} dari ${s.closed}` : "–"}
                      </div>
                      <div className={`text-[11px] ${s.win_rate == null ? "text-ink-3" : s.win_rate >= 0.5 ? "text-emerald-300/80" : "text-rose-300/80"}`}>
                        {s.win_rate == null ? "" : `${fmtNum(s.win_rate * 100, 0)}%`}
                      </div>
                    </td>
                    <td className={`px-3 py-3 text-right font-medium ${tone(s.pnl_7d_usd ?? null)}`}>
                      {s.pnl_7d_usd == null || (s.pnl_7d_usd === 0 && !s.closed) ? "–" : money(s.pnl_7d_usd)}
                    </td>
                    <td className="px-3 py-3 text-right text-ink-2">{s.positions_per_day == null ? "–" : fmtNum(s.positions_per_day, 1)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="text-ink-2">{s.avg_hold_hours == null ? "–" : `${span(s.avg_hold_hours)} / posisi`}</div>
                      <div className="text-[11px] text-ink-3">{s.total_hold_hours == null ? "" : `total ${span(s.total_hold_hours)}`}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-3 text-xs leading-5 text-ink-3 md:grid-cols-3">
        <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3">
          <span className="font-medium text-ink-2">Per modal</span> = total hasil ÷ total modal yang diputar. Ukuran posisi tiap strategi berbeda, jadi
          bandingkan di kolom ini, bukan di dolar.
        </p>
        <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3">
          <span className="font-medium text-ink-2">Median dan tanpa 3 terbaik</span> menunjukkan hasil trade yang biasa. Kalau total positif tapi
          keduanya negatif, untungnya datang dari satu-dua trade yang meledak.
        </p>
        <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3">
          <span className="font-medium text-ink-2">Semua paper</span>: tidak ada transaksi on-chain. Biaya swap, rent, dan fee jaringan sudah
          diperkirakan di tiap uji. Bukan saran finansial.
        </p>
      </section>
    </>
  );
}

const DEFAULT_PROFILES = [
  { key: "satu_sisi", label: "Satu Sisi" },
  { key: "satu_sisi_sering", label: "Satu Sisi Sering" },
];
// Every profile the engine may run, so a profile tab in the URL survives the first render before the list loads.
const PROFILE_TABS = Object.keys(PROFILE_COLORS);
const ALL_TABS = [...TABS, ...PROFILE_TABS];

export default function PaperHub() {
  const [tab, setTab] = useUrlState<string>("tab", "ringkasan", ALL_TABS);
  const { data, error } = useOverview();
  // One tab per running profile, between the overview and Panda, in the engine's order.
  // Until the overview loads, the profiles running now, so the tab bar does not jump. (Same list on the server and
  // the first client render, so hydration matches.)
  const loaded = (data?.strategies ?? [])
    .filter((s) => s.tab === "lp" && s.profile)
    .map((p) => ({ key: p.profile as string, label: p.label }));
  const profiles = loaded.length ? loaded : DEFAULT_PROFILES;
  const tabs: { key: string; label: string; kind?: "lp" | "order" }[] = [
    { key: "ringkasan", label: TAB_LABEL.ringkasan },
    ...profiles.map((p) => ({ ...p, kind: "lp" as const })),
    { key: "panda", label: TAB_LABEL.panda, kind: "lp" },
    { key: "sol", label: TAB_LABEL.sol, kind: "order" },
  ];
  const isProfile = PROFILE_TABS.includes(tab);
  const subtitle = isProfile ? TAB_SUBTITLE.lp : TAB_SUBTITLE[(TABS as readonly string[]).includes(tab) ? (tab as Tab) : "ringkasan"];

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader title="Paper" accent="trading" subtitle={subtitle} />

        <nav className="flex gap-1 overflow-x-auto border-b border-line" role="tablist" aria-label="Uji paper">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                tab === t.key ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
              }`}
            >
              {t.label}
              {t.kind && (
                <span
                  title={t.kind === "lp" ? "Strategi LP: posisi likuiditas DLMM" : "Strategi limit order, bukan posisi LP"}
                  className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${
                    t.kind === "lp" ? "bg-accent/15 text-accent" : "bg-sky-400/15 text-sky-300"
                  }`}
                >
                  {t.kind === "lp" ? "LP" : "Order"}
                </span>
              )}
            </button>
          ))}
        </nav>

        {tab === "ringkasan" && (
          <Summary
            data={data}
            error={error}
            onOpen={(s) => {
              setTab(s.tab === "lp" && s.profile ? s.profile : s.tab);
              window.scrollTo({ top: 0 });
            }}
          />
        )}
        {isProfile && <PaperPage key={tab} embedded fixedProfile={tab} />}
        {tab === "lp" && <PaperPage embedded /> /* old links to the single "Profil LP" tab */}
        {tab === "panda" && <PandaPage embedded />}
        {tab === "sol" && <SolGrid />}
      </main>
    </div>
  );
}
