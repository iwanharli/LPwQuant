"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, usd, usdCompact } from "../lib/format";
import { useUrlState } from "../lib/url-state";
import { EXIT_TONE } from "../lib/exit-status";
import { STRATEGY_NOTES, type StrategyNote } from "../lib/strategy-notes";
import { useAutoRefresh } from "../lib/auto-refresh";
import PageHeader from "./page-header";
import TopBar from "./top-bar";
import { SkeletonStrip, SkeletonTable, SkeletonTabs } from "./skeleton";

type Run = {
  id: number;
  pool: string;
  name: string;
  quote: string;
  status: "open" | "closed";
  exit_reason: string | null;
  size_usd: number;
  fees_usd: number;
  value_usd: number;
  token_value_usd: number;
  price_change_pct: number;
  deepest_drop_pct: number;
  last_tvl: number | null;
  costs_usd: number | null;
  rent_usd: number | null;
  pnl_usd: number;
  opened_at: number;
  closed_at: number | null;
  mint: string;
  entry_price: number;
  last_price: number | null;
  range_low_pct: number;
  bins: number;
  sol_usd: number;
  checked_at: number | null;
};
type Report = {
  params: {
    max_open: number;
    range_low_pct: number;
    size_usd: number;
    min_drop_before_exit_pct: number;
    min_hold_min: number;
    bins: number;
    position_rent_sol: number;
    new_bin_array_sol: number;
    max_hold_h: number;
    min_market_cap: number;
    min_volume_24h: number;
    min_fee_tvl_24h: number;
    min_holders: number;
    max_top10_pct: number;
    near_high_pct: number;
  };
  approximations: string[];
  counts: Record<string, number>;
  pnl_usd: number;
  pnl_without_rent_usd: number;
  fees_usd: number;
  capital_usd: number;
  win_rate: number | null;
  rent_locked_usd: number;
  screening_funnel: Record<string, number>;
  candidates?: { checked_at: number | null; slots?: number; pools: Candidate[] };
  rejected?: Record<string, Candidate[]>;
  runs: Run[];
};

const REASON: Record<string, { label: string; cls: string }> = {
  open: { label: "Berjalan", cls: EXIT_TONE.running },
  rsi2_bb: { label: "Exit: RSI(2) + Bollinger", cls: EXIT_TONE.planned },
  rsi2_macd: { label: "Exit: RSI(2) + MACD", cls: EXIT_TONE.planned },
  flatline: { label: "Datar, tak memantul", cls: EXIT_TONE.changed },
  time: { label: "72 jam", cls: EXIT_TONE.changed },
  vanished: { label: "Pool hilang", cls: EXIT_TONE.loss },
};
const money = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const tone = (v: number) => (v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-ink-2");

export function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

/** Paper test of the Panda Strat, with the screening funnel that the strategy itself calls 70% of the work. */
type View = "running" | "done" | "funnel" | "rules" | "notes";
const VIEWS = ["running", "done", "funnel", "rules", "notes"] as const;

function Rules({ p, approximations }: { p: Report["params"]; approximations: string[] }) {
  // Same card as the LP profiles' Aturan: entry on the left, exit on the right, notes underneath.
  const entry = [
    `Seleksi: market cap ≥ ${usdCompact.format(p.min_market_cap)}, volume 24 jam ≥ ${usdCompact.format(p.min_volume_24h)}, fee/TVL ≥ ${p.min_fee_tvl_24h}%, holder ≥ ${p.min_holders}, top-10 holder < ${p.max_top10_pct}%, insider < 10%, bundling < 60%, lolos cek keamanan, volume terbukti organik.`,
    `Pemicu: harga menembus ke atas Supertrend 15 menit dalam 1 jam terakhir, atau sedang di puncaknya dengan tren naik. Selalu masih dalam ${p.near_high_pct}% dari puncak.`,
    `Posisi: ${usd.format(p.size_usd)}, hanya SOL/USDC, tersebar rata dari harga sampai ${p.range_low_pct}% di bawahnya. Maksimal ${p.max_open} posisi sekaligus.`,
  ];
  const exit = [
    "Pantulan pertama: RSI(2) > 90 ditambah harga di atas Bollinger atas, atau ditambah batang hijau pertama MACD.",
    `Sinyal itu baru berlaku setelah harga turun ${p.min_drop_before_exit_pct}% atau posisi dipegang ${p.min_hold_min} menit.`,
    `Ditutup juga bila volume 24 jam mati atau posisi sudah ${p.max_hold_h} jam. Tanpa stop-loss.`,
    `Biaya: swap keluar 1% dari token tersisa dan biaya jaringan. Sewa posisi ${p.position_rent_sol} SOL kembali saat ditutup; sewa bin array ${p.new_bin_array_sol} SOL hanya bila range membuka array baru.`,
  ];
  return (
    <div className="space-y-5">
      <section className="grid gap-4 rounded-2xl border border-white/[0.06] bg-panel p-4 md:grid-cols-2">
        {[
          { title: "Masuk", items: entry },
          { title: "Keluar", items: exit },
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
      <section className="rounded-2xl border border-accent/25 bg-accent/[0.05] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold text-ink">Rencana perbaikan setelah 20 posisi selesai</h3>
          <span className="text-xs text-ink-3">dicatat 26/09 · belum dijalankan</span>
        </div>
        <p className="mt-1 text-sm leading-6 text-ink-3">
          Uji berjalan tanpa diubah sampai 20 posisi selesai. Yang diperhatikan: seberapa dalam rugi posisi yang tidak memantul. Kalau hasil tetap di
          sekitar nol atau minus, Panda dihentikan; kalau ingin idenya dipakai, versi berikut diuji berdampingan.
        </p>
        <ol className="mt-3 space-y-2 text-sm leading-6 text-ink-2">
          {[
            ["Range lebih sempit (−20% s/d −40%)", "likuiditas lebih pekat di dekat harga, bagian fee 3–5× lebih besar, rugi maksimum terbatas."],
            ["Batas keluar struktural", "keluar bila harga menembus bawah range atau tidak memantul dalam 24 jam; rugi dipotong di −20% s/d −30%, bukan −74%."],
            ["Masuk setelah dump pertama, bukan di puncak", "pump memecoin memuncak ±menit ke-10 lalu turun; masuk setelah turun 30–50% sesuai logika beli-saat-jatuh."],
            ["Keluar di pantulan hanya bila sudah untung bersih", "sinyal RSI(2) + Bollinger/MACD sekarang menutup posisi meski masih rugi (GO-SOL keluar di −45,5% dengan −$12,36 saat pantulan kecil). Bila belum untung, tahan sampai sinyal berikutnya, pool mati, atau batas waktu; perlu dipasangkan dengan batas keluar struktural (no. 2) agar posisi yang tak kembali tidak ditahan terlalu lama."],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-bold text-accent">{i + 1}</span>
              <span>
                <span className="font-medium text-ink">{t}</span> — {d}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs leading-5 text-ink-3">
          Alasan: fee Panda hanya ±$0,1–2 per posisi $100 (likuiditas tersebar di ±233 bin), sehingga hasil bergantung pada pantulan harga. Tanpa
          stop, titik impasnya butuh ±97% posisi menang.
        </p>
      </section>
      <div className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3 text-sm leading-6 text-ink-3">
        <div className="font-medium text-ink-2">Yang tidak bisa ditiru persis</div>
        <ul className="mt-1 space-y-1">
          {approximations.map((a) => (
            <li key={a}>· {a}</li>
          ))}
        </ul>
        <p className="mt-2">
          Klaim performa Panda Strat di media sosial belum pernah diverifikasi on-chain; uji ini menjalankan aturannya dengan harga dan fee Meteora yang
          sebenarnya.
        </p>
      </div>
    </div>
  );
}

type Check = { key: string; label: string; ok: boolean; detail: string };
export type Candidate = {
  address: string;
  name: string;
  price: number | null;
  market_cap: number | null;
  volume_24h: number | null;
  tvl: number | null;
  fee_tvl_pct_24h: number | null;
  holders: number | null;
  top10_pct: number | null;
  change_pct_1h: number | null;
  checks: Check[];
  entry_ok: boolean;
  held: boolean;
  rejected?: boolean;
};

/** Pools that cleared every screening gate, each with the entry trigger broken into its parts. */
export function Candidates({
  data,
  title = "Lolos seleksi · checklist entry",
  empty = "Belum ada pool yang lolos semua filter seleksi.",
}: {
  data: { checked_at: number | null; slots?: number; pools: Candidate[] };
  title?: string;
  empty?: string;
}) {
  const pools = data.pools ?? [];
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <span className="text-xs text-ink-3">
          {data.checked_at ? `dicek ${fmtDateTime(data.checked_at)} WIB` : "menunggu pengecekan pertama"}
          {data.slots != null && data.slots <= 0 ? " · slot posisi penuh" : ""}
        </span>
      </div>
      {pools.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-3">{empty}</p>
      ) : (
        <ul className="divide-y divide-white/[0.05]">
          {pools.map((p) => {
            const status = p.rejected
              ? { label: "Gugur", cls: "bg-rose-400/10 text-rose-300" }
              : p.held
              ? { label: "Sedang dipegang", cls: "bg-sky-400/10 text-sky-300" }
              : p.entry_ok
                ? { label: "Siap masuk", cls: "bg-emerald-400/10 text-emerald-300" }
                : { label: "Tunggu sinyal", cls: "bg-amber-400/10 text-amber-300" };
            return (
              <li key={p.address} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={`/pool/${p.address}`} className="text-base font-semibold text-ink hover:text-accent">
                    {p.name.replace("-", "/")}
                  </Link>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>{status.label}</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm tabular-nums lg:ml-auto">
                    {[
                      ["MC", p.market_cap == null ? "–" : usdCompact.format(p.market_cap)],
                      ["Vol", p.volume_24h == null ? "–" : usdCompact.format(p.volume_24h)],
                      ["TVL", p.tvl == null ? "–" : usdCompact.format(p.tvl)],
                      ["Fee/TVL", p.fee_tvl_pct_24h == null ? "–" : `${fmtNum(p.fee_tvl_pct_24h, 0)}%`],
                      ["Holder", p.holders == null ? "–" : fmtNum(p.holders, 0)],
                      ["Top10", p.top10_pct == null ? "–" : `${fmtNum(p.top10_pct, 0)}%`],
                      ["1j", p.change_pct_1h == null ? "–" : `${p.change_pct_1h >= 0 ? "+" : ""}${fmtNum(p.change_pct_1h, 1)}%`],
                    ].map(([k, v]) => (
                      <span key={k} className="whitespace-nowrap">
                        <span className="text-xs text-ink-3">{k} </span>
                        <span className="font-medium text-ink">{v}</span>
                      </span>
                    ))}
                  </div>
                </div>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {p.checks.map((c) => (
                    <li
                      key={c.key}
                      title={c.detail}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
                        c.ok ? "border-emerald-400/20 bg-emerald-400/[0.06] text-ink-2" : "border-rose-400/25 bg-rose-400/[0.06] text-ink"
                      }`}
                    >
                      <span className={`font-bold ${c.ok ? "text-emerald-300" : "text-rose-300"}`}>{c.ok ? "✓" : "✕"}</span>
                      {c.label}
                      <span className="text-ink-3">· {c.detail}</span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Candidates on the left, funnel on the right; picking a funnel row shows that row's pools on the left. */
export function SelectionView({
  candidates,
  funnel,
  rejected,
}: {
  candidates: { checked_at: number | null; slots?: number; pools: Candidate[] };
  funnel: Record<string, number>;
  rejected?: Record<string, Candidate[]>;
}) {
  const [selected, setSelected] = useState("lolos");
  const pick = selected !== "lolos" && funnel[selected] ? selected : "lolos";
  const list = pick === "lolos" ? candidates : { ...candidates, pools: rejected?.[pick] ?? [] };
  const shown = list.pools.length;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[7fr_3fr]">
      <Candidates
        data={list}
        title={pick === "lolos" ? "Lolos seleksi · checklist entry" : `Gugur: ${pick} · ${funnel[pick]} pool${shown < funnel[pick] ? `, ${shown} teramai ditampilkan` : ""}`}
        empty={pick === "lolos" ? undefined : "Tidak ada pool untuk alasan ini."}
      />
      <Funnel funnel={funnel} selected={pick} onSelect={setSelected} />
    </div>
  );
}

export function Funnel({
  funnel,
  selected = "lolos",
  onSelect,
}: {
  funnel: Record<string, number>;
  selected?: string;
  onSelect?: (key: string) => void;
}) {
  const rows = Object.entries(funnel);
  const total = rows.reduce((n, [, v]) => n + v, 0);
  const passed = funnel.lolos ?? 0;
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-panel p-4">
      <h2 className="text-base font-semibold text-ink">Seleksi Pool · {total} pool dicek sekarang</h2>
      <p className="mt-0.5 text-sm text-ink-3">Klik salah satu untuk melihat pool-nya di sebelah kiri.</p>
      <button
        type="button"
        onClick={() => onSelect?.("lolos")}
        aria-pressed={selected === "lolos"}
        className={`mt-3 flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
          selected === "lolos" ? "border-emerald-400/60 bg-emerald-400/[0.14]" : "border-emerald-400/25 bg-emerald-400/[0.07] hover:bg-emerald-400/[0.11]"
        }`}
      >
        <span className="text-sm font-medium text-emerald-300">Lolos semua filter</span>
        <span className="text-lg font-semibold tabular-nums text-emerald-300">{passed}</span>
      </button>
      <ul className="mt-2 space-y-1">
        {rows
          .filter(([k]) => k !== "lolos")
          .map(([why, n]) => (
            <li key={why}>
              <button
                type="button"
                onClick={() => onSelect?.(why)}
                aria-pressed={selected === why}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  selected === why ? "bg-white/[0.07]" : "hover:bg-white/[0.03]"
                }`}
              >
              <span className={`min-w-0 flex-1 truncate ${selected === why ? "text-ink" : "text-ink-3"}`}>{why}</span>
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/[0.06]">
                <span className="block h-full rounded-full bg-ink-3/50" style={{ width: `${total ? (n / total) * 100 : 0}%` }} />
              </span>
              <span className="w-8 text-right tabular-nums text-ink-2">{n}</span>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
}

function price(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return n >= 1 ? n.toPrecision(6) : n.toPrecision(4);
}

function duration(from: number, to: number): string {
  const min = Math.max(0, Math.round((to - from) / 60_000));
  return min < 60 ? `${min} mnt` : `${Math.floor(min / 60)} j ${min % 60} mnt`;
}

function Detail({ x }: { x: Run }) {
  const low = x.entry_price * (1 + x.range_low_pct / 100);
  const end = x.closed_at ?? x.checked_at ?? x.opened_at;
  const cost = (x.costs_usd ?? 0) + (x.rent_usd ?? 0);
  const items: [string, string, string?][] = [
    ["Harga masuk", price(x.entry_price)],
    [x.status === "open" ? "Harga terakhir" : "Harga keluar", price(x.last_price), tone(x.price_change_pct)],
    ["Range", `${price(low)} – ${price(x.entry_price)}`, "text-ink-2"],
    ["Lebar range", `${fmtNum(x.range_low_pct, 0)}% · ${x.bins} bin`],
    ["Dibuka", fmtDateTime(x.opened_at)],
    [x.status === "open" ? "Dicek terakhir" : "Ditutup", fmtDateTime(end)],
    ["Lama dipegang", duration(x.opened_at, end)],
    ["Turun terdalam", `${fmtNum(x.deepest_drop_pct, 1)}%`],
    ["Fee didapat", `+${usd.format(x.fees_usd)}`, "text-emerald-300"],
    ["Nilai token", usd.format(x.token_value_usd)],
    ["Biaya swap", x.costs_usd == null ? "–" : usd.format(x.costs_usd), "text-amber-300/90"],
    ["Rent bin (hangus)", x.rent_usd == null ? "–" : usd.format(x.rent_usd), "text-amber-300/90"],
    ["Total biaya", x.status === "closed" ? usd.format(cost) : "saat ditutup", "text-amber-300/90"],
    ["Harga SOL saat masuk", usd.format(x.sol_usd)],
  ];
  return (
    <div className="grid gap-4 bg-white/[0.015] px-4 py-4 md:grid-cols-[1fr_auto]">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map(([k, v, cls]) => (
          <div key={k}>
            <dt className="text-[11px] uppercase tracking-[0.08em] text-ink-3">{k}</dt>
            <dd className={`mt-0.5 font-medium ${cls ?? "text-ink"}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-2 text-xs md:items-end">
        <Link href={`/pool/${x.pool}`} className="btn-accent rounded-full px-3 py-1.5 font-medium">Buka grafik pool</Link>
        <a href={`https://app.meteora.ag/dlmm/${x.pool}`} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-accent">Meteora ↗</a>
        {x.mint && <a href={`https://gmgn.ai/sol/token/${x.mint}`} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-accent">GMGN ↗</a>}
        <span className="font-mono text-[11px] text-ink-3">{x.pool.slice(0, 6)}…{x.pool.slice(-4)}</span>
      </div>
    </div>
  );
}

function RunTable({ runs, empty }: { runs: Run[]; empty: string }) {
  const [open, setOpen] = useState<number | null>(null);
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
              <th className="px-3 py-2.5 text-right font-medium">Turun terdalam</th>
              <th className="px-3 py-2.5 text-right font-medium">Fee</th>
              <th className="px-3 py-2.5 text-right font-medium">Nilai posisi</th>
              <th className="px-3 py-2.5 text-right font-medium">Biaya</th>
              <th className="px-3 py-2.5 text-right font-medium">Hasil</th>
              <th className="px-3 py-2.5 text-right font-medium" title="Dari dibuka sampai ditutup (atau sampai sekarang bila masih berjalan)">Lama</th>
              <th className="px-4 py-2.5 text-right font-medium">Waktu</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((x) => {
              const st = REASON[x.status === "open" ? "open" : x.exit_reason ?? "time"] ?? REASON.time;
              const cost = (x.costs_usd ?? 0) + (x.rent_usd ?? 0);
              return (
                <Fragment key={x.id}>
                <tr
                  onClick={() => setOpen(open === x.id ? null : x.id)}
                  className={`cursor-pointer border-b border-line/60 hover:bg-white/[0.02] ${open === x.id ? "bg-white/[0.02]" : ""}`}
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-ink">
                      <span className="mr-1.5 inline-block w-3 text-ink-3">{open === x.id ? "▾" : "▸"}</span>
                      {x.name.replace("-", "/")}
                    </span>
                    <div className="text-[11px] text-ink-3">
                      modal {usd.format(x.size_usd)} · TVL {x.last_tvl == null ? "–" : usdCompact.format(x.last_tvl)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
                  </td>
                  <td className={`px-3 py-2.5 text-right ${tone(x.price_change_pct)}`}>
                    {x.price_change_pct >= 0 ? "+" : ""}
                    {fmtNum(x.price_change_pct, 1)}%
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink-3">{fmtNum(x.deepest_drop_pct, 1)}%</td>
                  <td className="px-3 py-2.5 text-right text-emerald-300">+{usd.format(x.fees_usd)}</td>
                  <td className="px-3 py-2.5 text-right text-ink-2">
                    {usd.format(x.value_usd)}
                    <div className="text-[11px] text-ink-3">token {usd.format(x.token_value_usd)}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-amber-300/90">{x.status === "closed" ? usd.format(cost) : "–"}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${tone(x.pnl_usd)}`}>
                    {money(x.pnl_usd)}
                    {x.status === "open" && <div className="text-[11px] font-normal text-ink-3">sebelum biaya</div>}
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink-2">{duration(x.opened_at, x.closed_at ?? x.checked_at ?? x.opened_at)}</td>
                  <td className="px-4 py-2.5 text-right text-[11px] text-ink-3">{fmtDateTime(x.closed_at ?? x.opened_at)}</td>
                </tr>
                {open === x.id && (
                  <tr className="border-b border-line/60">
                    <td colSpan={10} className="p-0"><Detail x={x} /></td>
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

export default function PandaPage({ embedded = false }: { embedded?: boolean }) {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const [view, setView] = useUrlState<View>("panda", "running", VIEWS);

  const load = useCallback(() => {
    fetch(`${ENGINE_URL}/api/panda/paper`)
      .then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))))
      .then((b) => {
        setR(b as Report);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  // Same refresh as every other paper tab: every 30 s while visible, at once when the tab comes back.
  useAutoRefresh(load, 30_000);
  useEffect(load, [load]);

  const p = r?.params;
  const closed = r?.counts.closed ?? 0;
  const open = r?.counts.open ?? 0;
  const running = r?.runs.filter((x) => x.status === "open") ?? [];
  const finished = r?.runs.filter((x) => x.status === "closed") ?? [];

  const header = (
    <PageHeader
      title="Uji" accent="Panda Strat"
      subtitle="Paper, tanpa transaksi: seleksi ketat, range lebar satu sisi, keluar di pantulan pertama."
    />
  );
  const body = (
    <>
        {error && !r && <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>}

        {!r && !error && (
          <>
            <SkeletonStrip count={4} />
            <SkeletonTabs count={5} />
            <SkeletonTable rows={5} columns={6} title={false} />
          </>
        )}

        {r && p && (
          <>
            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
              <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
                <Kpi
                  label="Hasil bersih"
                  value={closed ? money(r.pnl_usd) : "–"}
                  hint={closed ? `${closed} posisi selesai · modal ${usd.format(r.capital_usd)}` : "belum ada yang selesai"}
                  cls={closed ? tone(r.pnl_usd) : undefined}
                />
                <Kpi
                  label="Fee terkumpul"
                  value={closed ? usd.format(r.fees_usd) : "–"}
                  hint="bagian kita dari fee pool, saat harga di dalam range"
                />
                <Kpi label="Win rate" value={r.win_rate == null ? "–" : `${fmtNum(r.win_rate * 100, 0)}%`} hint={`${open} posisi berjalan`} />
                <Kpi
                  label="Modal per posisi"
                  value={usd.format(p.size_usd)}
                  hint={`maks ${p.max_open} posisi · range ${p.range_low_pct}% pada ${p.bins} bin`}
                />
              </div>
            </section>

            <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Tampilan uji Panda">
              {(
                [
                  { value: "running", label: `Berjalan (${open})` },
                  { value: "done", label: `Selesai (${closed})` },
                  { value: "funnel", label: `Seleksi Pool (${r.screening_funnel.lolos ?? 0} lolos)` },
                  { value: "rules", label: "Aturan" },
                  { value: "notes", label: "Catatan" },
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

            {view === "running" && (
              <RunTable runs={running} empty="Belum ada posisi berjalan. Dicek tiap 5 menit: pool harus lolos seleksi dan memberi sinyal entry." />
            )}
            {view === "done" && <RunTable runs={finished} empty="Belum ada posisi yang selesai." />}
            {view === "funnel" && (
              <SelectionView
                candidates={r.candidates ?? { checked_at: null, pools: [] }}
                funnel={r.screening_funnel}
                rejected={r.rejected}
              />
            )}
            {view === "rules" && <Rules p={p} approximations={r.approximations} />}
            {view === "notes" && <StrategyNotes note={STRATEGY_NOTES.panda} />}
          </>
        )}
    </>
  );
  if (embedded) return <div className="space-y-5">{body}</div>;
  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        {header}
        {body}
      </main>
    </div>
  );
}

/** The Catatan sub-tab: written strengths, weaknesses and next steps for one strategy. */
export function StrategyNotes({ note }: { note: StrategyNote | undefined }) {
  if (!note) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center text-sm text-ink-3">Belum ada catatan.</p>;
  const blocks = [
    { title: "Kelebihan", items: note.pros, dot: "bg-emerald-400" },
    { title: "Kekurangan", items: note.cons, dot: "bg-rose-400" },
  ];
  return (
    <div className="space-y-5">
      <section className="grid gap-4 rounded-2xl border border-white/[0.06] bg-panel p-4 md:grid-cols-2">
        {blocks.map((b) => (
          <div key={b.title}>
            <h3 className="text-base font-semibold text-ink">{b.title}</h3>
            <ul className="mt-2 space-y-2 text-sm leading-6 text-ink-2">
              {b.items.map((t) => (
                <li key={t} className="flex gap-2">
                  <span className={`mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full ${b.dot}`} aria-hidden />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      <section className="rounded-2xl border border-accent/25 bg-accent/[0.05] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold text-ink">Saran update strategi</h3>
          <span className="text-xs text-ink-3">
            ditulis {note.written} · dasar: {note.basis}
          </span>
        </div>
        <ol className="mt-3 space-y-2 text-sm leading-6 text-ink-2">
          {note.next.map((t, i) => (
            <li key={t} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-bold text-accent">{i + 1}</span>
              <span>{t}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
