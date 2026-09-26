"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../../lib/auto-refresh";
import { EXIT_TONE } from "../../lib/exit-status";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../../lib/format";
import { STRATEGY_NOTES } from "../../lib/strategy-notes";
import { useUrlState } from "../../lib/url-state";
import { Kpi, StrategyNotes } from "../panda-page";
import RangeView, { RangeStrip } from "./range-view";
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
  min_price: number | null;
  max_price: number | null;
  price: number | null;
  opened_at: number;
  closed_at: number | null;
  checked_at: number | null;
};
type Leader = {
  wallet: string;
  pnl_7d_usd: number;
  positions_7d: number;
  win_rate: number | null;
  wins: number;
  sample: number;
  median_usd: number | null;
  median_pct: number | null;
  hold_median_h: number | null;
  deposit_median_usd: number | null;
  lifetime_pnl_usd: number;
  lifetime_closed: number;
  last_closed_at: number | null;
  top_pairs: string[];
};

const MEDAL = ["🥇", "🥈", "🥉"];

/** One followed wallet: who it is, how it trades, and what copying it has returned so far. */
function WalletCard({ w, rank, runs }: { w: Leader; rank: number; runs: Run[] }) {
  const mine = runs.filter((r) => r.wallet === w.wallet);
  const open = mine.filter((r) => r.status === "open").length;
  const done = mine.filter((r) => r.status === "closed");
  const copyPnl = done.reduce((n, r) => n + r.pnl_usd, 0);
  const copyWins = done.filter((r) => r.pnl_usd > 0).length;
  const wr = w.win_rate == null ? null : w.win_rate * 100;
  const tiles: [string, string, string?][] = [
    ["Hasil 7 hari", money(w.pnl_7d_usd), tone(w.pnl_7d_usd)],
    ["Median / posisi", w.median_usd == null ? "–" : `${money(w.median_usd)}`, tone(w.median_usd)],
    ["Lama pegang", w.hold_median_h == null ? "–" : span(w.hold_median_h * 3_600_000)],
    ["Modal / posisi", w.deposit_median_usd == null ? "–" : usd.format(w.deposit_median_usd)],
  ];
  return (
    <article className="flex flex-col rounded-2xl border border-white/[0.06] bg-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`grid h-10 w-10 place-items-center rounded-full text-lg font-extrabold ${
              rank <= 3 ? "bg-gradient-to-br from-amber-200/25 to-amber-600/10" : "border border-white/[0.1] bg-white/[0.04] text-sm text-ink-2"
            }`}
          >
            {MEDAL[rank - 1] ?? rank}
          </span>
          <div>
            <div className="font-mono text-base font-semibold text-ink">{short(w.wallet)}</div>
            <div className="text-[11px] text-ink-3">
              seumur hidup <span className={tone(w.lifetime_pnl_usd)}>{money(w.lifetime_pnl_usd)}</span> · {fmtNum(w.lifetime_closed, 0)} posisi
            </div>
          </div>
        </div>
        {open > 0 && (
          <span className="live-breath inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
            {open} ditiru
          </span>
        )}
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-ink-3">Win rate</span>
          <span className={`text-lg font-bold tabular-nums ${wr == null ? "text-ink-3" : wr >= 50 ? "text-emerald-300" : "text-rose-300"}`}>
            {wr == null ? "–" : `${fmtNum(wr, 0)}%`}
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300" style={{ width: `${Math.min(100, wr ?? 0)}%` }} />
        </div>
        <div className="mt-1 text-[11px] text-ink-3">
          {w.wins} dari {w.sample} posisi untung · {w.positions_7d} posisi dalam 7 hari
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        {tiles.map(([k, v, cls]) => (
          <div key={k}>
            <dt className="text-[11px] uppercase tracking-[0.08em] text-ink-3">{k}</dt>
            <dd className={`mt-0.5 font-semibold tabular-nums ${cls ?? "text-ink"}`}>{v}</dd>
          </div>
        ))}
      </dl>

      {w.top_pairs.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {w.top_pairs.map((pair) => (
            <span key={pair} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-ink-2">
              {pair}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
        <div className="text-[11px] uppercase tracking-[0.08em] text-ink-3">Hasil tiruan kita</div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className={`text-base font-semibold tabular-nums ${done.length ? tone(copyPnl) : "text-ink-3"}`}>
            {done.length ? money(copyPnl) : "belum ada yang selesai"}
          </span>
          <span className="text-[11px] text-ink-3">
            {done.length ? `${copyWins} dari ${done.length} untung · ` : ""}
            {open} berjalan
          </span>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap gap-3 pt-4 text-xs">
        <a href={`https://solscan.io/account/${w.wallet}`} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-accent">
          Solscan ↗
        </a>
        <a href={`https://gmgn.ai/sol/address/${w.wallet}`} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-accent">
          GMGN ↗
        </a>
        {w.last_closed_at && <span className="ml-auto text-ink-3">aktif {fmtDateTime(w.last_closed_at)}</span>}
      </div>
    </article>
  );
}
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
  const [openId, setOpenId] = useState<number | null>(null);
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
            {runs.map((r) => {
              const open = openId === r.id;
              return (
              <Fragment key={r.id}>
              <tr
                onClick={() => setOpenId(open ? null : r.id)}
                className={`cursor-pointer border-b border-line/60 hover:bg-white/[0.02] ${open ? "bg-white/[0.02]" : ""}`}
              >
                <td className="px-4 py-2.5">
                  <span className="font-medium text-ink">
                    <span className="mr-1.5 inline-block w-3 text-ink-3">{open ? "▾" : "▸"}</span>
                    {r.pair}
                  </span>
                  <div className="text-[11px] text-ink-3">
                    modal {usd.format(r.size_usd)}
                    {r.their_deposit_usd ? ` · wallet ${usd.format(r.their_deposit_usd)}` : ""}
                  </div>
                  {r.min_price && r.max_price ? <RangeStrip min={r.min_price} max={r.max_price} current={r.price} /> : null}
                </td>
                <td className="px-3 py-2.5">
                  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "open" ? EXIT_TONE.running : EXIT_TONE.planned}`}>
                    {r.status === "open" ? "Berjalan" : "Ditutup bersama wallet"}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <a
                    href={`https://solscan.io/account/${r.wallet}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-ink-2 hover:text-accent"
                  >
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
              {open && (
                <tr className="border-b border-line/60">
                  <td colSpan={8} className="p-0">
                    <div className="grid gap-4 bg-white/[0.015] px-4 py-4 md:grid-cols-[1fr_auto]">
                      {r.min_price && r.max_price ? (
                        <div className="md:col-span-2">
                          <RangeView min={r.min_price} max={r.max_price} current={r.price} shape="spot" bins={70} token={r.pair.split("/")[0]} quote={r.pair.split("/")[1] ?? "SOL"} />
                        </div>
                      ) : null}
                          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
                            {(
                              [
                                ["Wallet", short(r.wallet)],
                                ["Modal wallet", r.their_deposit_usd ? usd.format(r.their_deposit_usd) : "–"],
                                ["Modal tiruan", usd.format(r.size_usd)],
                                ["Range", r.min_price && r.max_price ? `${r.min_price.toPrecision(4)} – ${r.max_price.toPrecision(4)}` : "–"],
                                ["Jeda deteksi", r.delay_s == null ? "–" : span(r.delay_s * 1000)],
                                ["PnL wallet saat ditiru", `${fmtNum(r.entry_pnl_pct ?? 0, 2)}%`],
                                [r.status === "open" ? "PnL wallet sekarang" : "PnL wallet akhir", `${fmtNum((r.status === "open" ? r.last_pnl_pct : r.exit_pnl_pct) ?? 0, 2)}%`],
                                ["Hasil tiruan", `${money(r.pnl_usd)} (${r.result_pct >= 0 ? "+" : ""}${fmtNum(r.result_pct, 2)}%)`],
                                ["Biaya tiruan", r.costs_usd == null ? "saat ditutup" : usd.format(r.costs_usd)],
                                ["Ditiru sejak", fmtDateTime(r.opened_at)],
                                [r.status === "open" ? "Dicek terakhir" : "Ditutup", fmtDateTime(r.closed_at ?? r.checked_at ?? r.opened_at)],
                              ] as [string, string][]
                            ).map(([k, v]) => (
                              <div key={k}>
                                <dt className="text-[11px] uppercase tracking-[0.08em] text-ink-3">{k}</dt>
                                <dd className="mt-0.5 font-medium text-ink">{v}</dd>
                              </div>
                            ))}
                          </dl>
                          <div className="flex flex-col gap-2 text-xs md:items-end">
                            <Link href={`/pool/${r.pool}`} className="btn-accent rounded-full px-3 py-1.5 font-medium">Buka grafik pool</Link>
                            <a href={`https://app.meteora.ag/dlmm/${r.pool}`} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-accent">Meteora ↗</a>
                            <span className="font-mono text-[11px] text-ink-3">{r.pool.slice(0, 6)}…{r.pool.slice(-4)}</span>
                          </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Copies, one collapsible group per wallet, best total first: which wallets are worth copying at a glance. Used for
 * both the running copies (marked to the wallet's current PnL) and the finished ones. */
function Grouped({ runs, empty, noun }: { runs: Run[]; empty: string; noun: string }) {
  const [openWallet, setOpenWallet] = useState<string | null>(null);
  if (runs.length === 0) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center text-sm text-ink-3">{empty}</p>;
  const groups = Object.values(
    runs.reduce<Record<string, Run[]>>((acc, r) => {
      (acc[r.wallet] ??= []).push(r);
      return acc;
    }, {}),
  )
    .map((list) => {
      const pnl = list.reduce((n, r) => n + r.pnl_usd, 0);
      const wins = list.filter((r) => r.pnl_usd > 0).length;
      const avg = list.reduce((n, r) => n + r.result_pct, 0) / list.length;
      const delays = list.map((r) => r.delay_s ?? 0).sort((a, b) => a - b);
      return { wallet: list[0].wallet, list, pnl, wins, avg, delay: delays[Math.floor(delays.length / 2)] };
    })
    .sort((a, b) => b.pnl - a.pnl);
  return (
    <div className="space-y-3">
      {groups.map((g, i) => {
        const open = openWallet === g.wallet;
        const wr = (g.wins / g.list.length) * 100;
        return (
          <section key={g.wallet} className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
            <button
              type="button"
              onClick={() => setOpenWallet(open ? null : g.wallet)}
              aria-expanded={open}
              className="grid w-full grid-cols-2 items-center gap-x-5 gap-y-2 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.02] md:grid-cols-[auto_1.4fr_1fr_1fr_1fr_1fr_auto]"
            >
              <span
                className={`grid h-9 w-9 place-items-center rounded-full font-extrabold ${
                  i < 3 && g.pnl > 0 ? "bg-gradient-to-br from-amber-200/25 to-amber-600/10 text-lg" : "border border-white/[0.1] bg-white/[0.04] text-sm text-ink-2"
                }`}
              >
                {i < 3 && g.pnl > 0 ? MEDAL[i] : i + 1}
              </span>
              <span>
                <span className="font-mono font-semibold text-ink">{short(g.wallet)}</span>
                <span className="block text-[11px] text-ink-3">
                  {g.list.length} {noun}
                </span>
              </span>
              <span>
                <span className="block text-[11px] uppercase tracking-[0.08em] text-ink-3">Hasil</span>
                <span className={`font-semibold tabular-nums ${tone(g.pnl)}`}>{money(g.pnl)}</span>
              </span>
              <span>
                <span className="block text-[11px] uppercase tracking-[0.08em] text-ink-3">{noun.includes("berjalan") ? "Posisi untung" : "Win rate"}</span>
                {noun.includes("berjalan") ? (
                  <span className={`font-semibold tabular-nums ${wr >= 50 ? "text-emerald-300" : "text-rose-300"}`}>
                    {g.wins} dari {g.list.length} <span className="text-[11px] font-normal text-ink-3">({fmtNum(wr, 0)}%)</span>
                  </span>
                ) : (
                  <span className={`font-semibold tabular-nums ${wr >= 50 ? "text-emerald-300" : "text-rose-300"}`}>
                    {fmtNum(wr, 0)}% <span className="text-[11px] font-normal text-ink-3">({g.wins}/{g.list.length})</span>
                  </span>
                )}
              </span>
              <span>
                <span className="block text-[11px] uppercase tracking-[0.08em] text-ink-3">Rata-rata</span>
                <span className={`font-semibold tabular-nums ${tone(g.avg)}`}>
                  {g.avg >= 0 ? "+" : ""}
                  {fmtNum(g.avg, 2)}%
                </span>
              </span>
              <span>
                <span className="block text-[11px] uppercase tracking-[0.08em] text-ink-3">Jeda median</span>
                <span className="font-semibold tabular-nums text-ink-2">{span(g.delay * 1000)}</span>
              </span>
              <span className="text-ink-3">{open ? "▾" : "▸"}</span>
            </button>
            {open && (
              <div className="border-t border-line p-2">
                <Table runs={g.list} empty="" />
              </div>
            )}
          </section>
        );
      })}
    </div>
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
        <Grouped
          runs={running}
          noun="tiruan berjalan"
          empty={`Belum ada tiruan berjalan. Dicek tiap ${p.tick_s / 60} menit: menunggu wallet yang diikuti membuka posisi baru.`}
        />
      )}
      {view === "selesai" && <Grouped runs={done} noun="tiruan selesai" empty="Belum ada tiruan yang selesai." />}
      {view === "wallet" &&
        (r.wallets.length === 0 ? (
          <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center text-sm text-ink-3">
            Belum ada wallet yang layak diikuti. Daftar diambil dari halaman LP teratas.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-3">
              {r.wallets.length} wallet teratas di <Link href="/leaders" className="text-ink-2 underline decoration-white/20 hover:text-accent">LP teratas</Link> yang
              layak diikuti, diurutkan hasil 7 hari. Daftarnya ikut berubah tiap 6 jam.
            </p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {r.wallets.map((w, i) => (
                <WalletCard key={w.wallet} w={w} rank={i + 1} runs={r.runs} />
              ))}
            </div>
          </div>
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
