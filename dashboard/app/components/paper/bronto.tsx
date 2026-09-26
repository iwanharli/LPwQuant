"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../../lib/auto-refresh";
import { EXIT_TONE } from "../../lib/exit-status";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../../lib/format";
import { STRATEGY_NOTES } from "../../lib/strategy-notes";
import { useUrlState } from "../../lib/url-state";
import { Kpi, SelectionView, StrategyNotes, type Candidate } from "../panda-page";
import RangeView, { RangeStrip } from "./range-view";
import { SkeletonStrip, SkeletonTable, SkeletonTabs } from "../skeleton";

type Run = {
  id: number;
  pool: string;
  name: string;
  status: "open" | "closed";
  exit_reason: string | null;
  size_usd: number;
  fees_usd: number;
  value_usd: number;
  price_change_pct: number;
  in_range: boolean;
  costs_usd: number;
  pnl_usd: number;
  bin_step: number;
  base_fee_pct: number | null;
  new_arrays: number;
  range_low_pct: number;
  range_high_pct: number;
  entry_price: number;
  last_price: number;
  opened_at: number;
  closed_at: number | null;
  checked_at: number | null;
};
type Report = {
  params: {
    size_usd: number;
    max_open: number;
    bins: number;
    min_base_fee_pct: number;
    min_bin_step: number;
    min_volume_24h: number;
    min_fee_tvl_24h: number;
    min_tvl: number;
    target_hold_h: number;
    max_hold_h: number;
    tick_s: number;
  };
  counts: { open: number; closed: number };
  pnl_usd: number;
  fees_usd: number;
  win_rate: number | null;
  screening_funnel: Record<string, number>;
  candidates: { checked_at: number | null; pools: Candidate[] };
  runs: Run[];
};

const REASON: Record<string, { label: string; cls: string }> = {
  open: { label: "Berjalan", cls: EXIT_TONE.running },
  target: { label: "Untung setelah 12 jam", cls: EXIT_TONE.planned },
  time: { label: "Batas 72 jam", cls: EXIT_TONE.changed },
  pulled: { label: "Likuiditas dicabut", cls: EXIT_TONE.loss },
  vanished: { label: "Pool hilang", cls: EXIT_TONE.loss },
};
const money = (n: number | null | undefined) => (n == null ? "–" : `${n >= 0 ? "+" : "−"}${usd.format(Math.abs(n))}`);
const tone = (n: number | null | undefined) => (n == null ? "text-ink-3" : n > 0.005 ? "text-emerald-300" : n < -0.005 ? "text-rose-300" : "text-ink-2");
const span = (ms: number) => {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)} mnt` : h < 48 ? `${fmtNum(h, 1)} jam` : `${fmtNum(h / 24, 1)} hari`;
};
const VIEWS = ["berjalan", "selesai", "seleksi", "aturan", "catatan"] as const;
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
              <th className="px-3 py-2.5 text-right font-medium">Harga</th>
              <th className="px-3 py-2.5 text-right font-medium">Fee</th>
              <th className="px-3 py-2.5 text-right font-medium">Nilai posisi</th>
              <th className="px-3 py-2.5 text-right font-medium">Biaya</th>
              <th className="px-3 py-2.5 text-right font-medium">Hasil</th>
              <th className="px-3 py-2.5 text-right font-medium">Lama</th>
              <th className="px-4 py-2.5 text-right font-medium">Waktu</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((x) => {
              const st = REASON[x.status === "open" ? "open" : x.exit_reason ?? "time"] ?? REASON.time;
              const open = openId === x.id;
              return (
                <Fragment key={x.id}>
                <tr
                  onClick={() => setOpenId(open ? null : x.id)}
                  className={`cursor-pointer border-b border-line/60 hover:bg-white/[0.02] ${open ? "bg-white/[0.02]" : ""}`}
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-ink">
                      <span className="mr-1.5 inline-block w-3 text-ink-3">{open ? "▾" : "▸"}</span>
                      {x.name.replace("-", "/")}
                    </span>
                    <div className="text-[11px] text-ink-3">
                      fee {fmtNum(x.base_fee_pct ?? 0, 1)}% · range {fmtNum(x.range_low_pct, 0)}% / +{fmtNum(x.range_high_pct, 0)}%
                    </div>
                    <RangeStrip min={x.entry_price * (1 + x.range_low_pct / 100)} max={x.entry_price * (1 + x.range_high_pct / 100)} current={x.last_price} />
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
                    {x.status === "open" && !x.in_range && <div className="mt-1 text-[11px] text-amber-300">di luar range</div>}
                  </td>
                  <td className={`px-3 py-2.5 text-right ${tone(x.price_change_pct)}`}>
                    {x.price_change_pct >= 0 ? "+" : ""}
                    {fmtNum(x.price_change_pct, 1)}%
                  </td>
                  <td className="px-3 py-2.5 text-right text-emerald-300">+{usd.format(x.fees_usd)}</td>
                  <td className="px-3 py-2.5 text-right text-ink-2">{usd.format(x.value_usd)}</td>
                  <td className="px-3 py-2.5 text-right text-amber-300/90">{usd.format(x.costs_usd)}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${tone(x.pnl_usd)}`}>{money(x.pnl_usd)}</td>
                  <td className="px-3 py-2.5 text-right text-ink-2">{span((x.closed_at ?? x.checked_at ?? x.opened_at) - x.opened_at)}</td>
                  <td className="px-4 py-2.5 text-right text-[11px] text-ink-3">{fmtDateTime(x.closed_at ?? x.opened_at)}</td>
                </tr>
                {open && (
                  <tr className="border-b border-line/60">
                    <td colSpan={9} className="p-0">
                      <div className="grid gap-4 bg-white/[0.015] px-4 py-4 md:grid-cols-[1fr_auto]">
                        <div className="md:col-span-2">
                          <RangeView
                            min={x.entry_price * (1 + x.range_low_pct / 100)}
                            max={x.entry_price * (1 + x.range_high_pct / 100)}
                            current={x.last_price}
                            entry={x.entry_price}
                            shape="spot"
                            bins={70}
                            token={x.name.split("-")[0]}
                          />
                        </div>
                          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
                            {(
                              [
                                ["Fee dasar pool", `${fmtNum(x.base_fee_pct ?? 0, 2)}%`],
                                ["Bin step", `${x.bin_step} · 70 bin`],
                                ["Range", `${fmtNum(x.range_low_pct, 1)}% / +${fmtNum(x.range_high_pct, 1)}%`],
                                ["Posisi harga", x.in_range ? "di dalam range" : "di luar range"],
                                ["Perubahan harga", `${x.price_change_pct >= 0 ? "+" : ""}${fmtNum(x.price_change_pct, 1)}%`],
                                ["Dibuka", fmtDateTime(x.opened_at)],
                                [x.status === "open" ? "Dicek terakhir" : "Ditutup", fmtDateTime(x.closed_at ?? x.checked_at ?? x.opened_at)],
                                ["Lama dipegang", span((x.closed_at ?? x.checked_at ?? x.opened_at) - x.opened_at)],
                                ["Fee didapat", `+${usd.format(x.fees_usd)}`],
                                ["Nilai posisi", usd.format(x.value_usd)],
                                ["Biaya (masuk + keluar)", usd.format(x.costs_usd)],
                                ["Sewa bin array baru", x.new_arrays ? `${x.new_arrays} array` : "tidak ada"],
                                ["Hasil", money(x.pnl_usd)],
                              ] as [string, string][]
                            ).map(([k, v]) => (
                              <div key={k}>
                                <dt className="text-[11px] uppercase tracking-[0.08em] text-ink-3">{k}</dt>
                                <dd className="mt-0.5 font-medium text-ink">{v}</dd>
                              </div>
                            ))}
                          </dl>
                          <div className="flex flex-col gap-2 text-xs md:items-end">
                            <Link href={`/pool/${x.pool}`} className="btn-accent rounded-full px-3 py-1.5 font-medium">Buka grafik pool</Link>
                            <a href={`https://app.meteora.ag/dlmm/${x.pool}`} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-accent">Meteora ↗</a>
                            <span className="font-mono text-[11px] text-ink-3">{x.pool.slice(0, 6)}…{x.pool.slice(-4)}</span>
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

export default function Bronto() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    fetch(`${ENGINE_URL}/api/paper/brontosaurus`)
      .then((x) => (x.ok ? x.json() : Promise.reject(x.status)))
      .then((b: Report) => {
        setR(b);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  useAutoRefresh(load, 30_000);
  useEffect(load, [load]);
  const [view, setView] = useUrlState<View>("bronto", "berjalan", VIEWS);

  if (!r && error) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>;
  if (!r)
    return (
      <>
        <SkeletonStrip count={4} />
        <SkeletonTabs count={5} />
        <SkeletonTable rows={5} columns={8} title={false} />
      </>
    );
  const p = r.params;
  const running = r.runs.filter((x) => x.status === "open");
  const done = r.runs.filter((x) => x.status === "closed");

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
        <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
          <Kpi label="Hasil bersih" value={done.length ? money(r.pnl_usd) : "–"} cls={done.length ? tone(r.pnl_usd) : undefined} hint={`${done.length} posisi selesai`} />
          <Kpi label="Fee terkumpul" value={done.length ? usd.format(r.fees_usd) : "–"} hint="bagian kita dari fee pool, saat harga di dalam range" />
          <Kpi label="Win rate" value={r.win_rate == null ? "–" : `${fmtNum(r.win_rate * 100, 0)}%`} hint={`${running.length} posisi berjalan`} />
          <Kpi label="Modal per posisi" value={usd.format(p.size_usd)} hint={`maks ${p.max_open} posisi · ${p.bins} bin`} />
        </div>
      </section>

      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Tampilan Brontosaurus">
        {(
          [
            { value: "berjalan", label: `Berjalan (${running.length})` },
            { value: "selesai", label: `Selesai (${done.length})` },
            { value: "seleksi", label: `Seleksi Pool (${r.screening_funnel.lolos ?? 0} lolos)` },
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

      {view === "berjalan" && <Table runs={running} empty={`Belum ada posisi berjalan. Dicek tiap ${p.tick_s / 60} menit.`} />}
      {view === "selesai" && <Table runs={done} empty="Belum ada posisi yang selesai." />}
      {view === "seleksi" && <SelectionView candidates={r.candidates} funnel={r.screening_funnel} />}
      {view === "aturan" && (
        <section className="grid gap-4 rounded-2xl border border-white/[0.06] bg-panel p-4 md:grid-cols-2">
          {[
            {
              title: "Masuk",
              items: [
                `Pool memecoin berpasangan SOL, fee dasar ≥ ${p.min_base_fee_pct}%, bin step ≥ ${p.min_bin_step}, TVL ≥ ${usd.format(p.min_tvl)}, volume 24 jam ≥ ${usd.format(p.min_volume_24h)}, fee/TVL ≥ ${p.min_fee_tvl_24h}%.`,
                "Tanpa flag risiko, tidak sedang pump (+30%/jam), dan token sudah lebih dari 24 jam.",
                `Posisi ${usd.format(p.size_usd)}, spot (nilai rata per bin) di ${p.bins} bin berpusat di harga. Maksimal ${p.max_open} posisi sekaligus.`,
              ],
            },
            {
              title: "Keluar",
              items: [
                `Setelah ${p.target_hold_h} jam: ditutup begitu untung bersih (sudah termasuk biaya jual sisa token).`,
                "Posisi yang masih rugi ditahan sampai pulih, seperti wallet aslinya.",
                `Batas ${p.max_hold_h} jam, atau lebih cepat bila likuiditas pool dicabut (TVL < 30% dari puncak). Tanpa stop-loss.`,
                "Biaya: swap separuh modal ke token saat masuk dan jual sisanya saat keluar (fee pool + 0,3% dampak), fee jaringan, sewa bin array yang belum ada.",
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
      {view === "catatan" && <StrategyNotes note={STRATEGY_NOTES.bronto} />}
    </>
  );
}
