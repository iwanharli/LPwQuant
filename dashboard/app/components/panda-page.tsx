"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, usd, usdCompact } from "../lib/format";
import { useUrlState } from "../lib/url-state";
import PageHeader from "./page-header";
import TopBar from "./top-bar";

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
  runs: Run[];
};

const REASON: Record<string, { label: string; cls: string }> = {
  open: { label: "Berjalan", cls: "bg-sky-400/10 text-sky-300" },
  rsi2_bb: { label: "Exit: RSI(2) + Bollinger", cls: "bg-emerald-400/10 text-emerald-300" },
  rsi2_macd: { label: "Exit: RSI(2) + MACD", cls: "bg-emerald-400/10 text-emerald-300" },
  flatline: { label: "Datar, tak memantul", cls: "bg-rose-400/10 text-rose-300" },
  time: { label: "72 jam", cls: "bg-white/[0.06] text-ink-2" },
  vanished: { label: "Pool hilang", cls: "bg-rose-400/10 text-rose-300" },
};
const money = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const tone = (v: number) => (v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-ink-2");

function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

/** Paper test of the Panda Strat, with the screening funnel that the strategy itself calls 70% of the work. */
type View = "running" | "done" | "funnel" | "rules";
const VIEWS = ["running", "done", "funnel", "rules"] as const;

function Rules({ p, approximations }: { p: Report["params"]; approximations: string[] }) {
  const rows = [
    {
      title: "Seleksi",
      body: `Market cap ≥ ${usdCompact.format(p.min_market_cap)}, volume 24 jam ≥ ${usdCompact.format(p.min_volume_24h)}, fee/TVL ≥ ${p.min_fee_tvl_24h}%, holder ≥ ${p.min_holders}, top-10 holder < ${p.max_top10_pct}%, insider < 10%, bundling < 60%, lolos cek keamanan, dan volume terbukti organik.`,
    },
    {
      title: "Entry",
      body: `Harga menembus ke atas Supertrend 15 menit dalam 1 jam terakhir, atau harga sedang di puncaknya dengan tren sudah naik. Selalu masih dalam ${p.near_high_pct}% dari puncak.`,
    },
    {
      title: "Posisi",
      body: `${usd.format(p.size_usd)}, hanya sisi SOL/USDC, tersebar rata dari harga sampai ${p.range_low_pct}% di bawahnya pada ${p.bins} bin. Maksimal ${p.max_open} posisi sekaligus.`,
    },
    {
      title: "Exit",
      body: `RSI(2) > 90 ditambah harga di atas upper Bollinger, atau RSI(2) > 90 ditambah batang hijau pertama MACD. Sinyal itu baru berlaku setelah harga turun ${p.min_drop_before_exit_pct}% atau posisi dipegang ${p.min_hold_min} menit, karena fase panen fee terjadi saat harga jatuh. Ditutup juga bila volume mati atau lewat ${p.max_hold_h} jam.`,
    },
    {
      title: "Biaya",
      body: `Swap keluar 1% dari token tersisa dan biaya jaringan. Sewa posisi ${p.position_rent_sol} SOL dikembalikan saat ditutup; sewa bin array ${p.new_bin_array_sol} SOL hanya kalau range membuat bin baru.`,
    },
  ];
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold text-ink">Aturan yang dijalankan</h2>
        <dl className="mt-3 space-y-3">
          {rows.map((r) => (
            <div key={r.title}>
              <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-3">{r.title}</dt>
              <dd className="mt-1 text-xs leading-5 text-ink-2">{r.body}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold text-ink">Yang tidak bisa ditiru persis</h2>
        <ul className="mt-3 space-y-2 text-xs leading-5 text-ink-2">
          {approximations.map((a) => (
            <li key={a} className="flex gap-2">
              <span className="text-ink-3">·</span>
              <span>{a}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-5 text-ink-2">
          Semua klaim performa Panda Strat di media sosial belum pernah diverifikasi on-chain. Uji ini menjalankan aturannya dengan harga dan fee Meteora
          yang sebenarnya, supaya angkanya datang dari data, bukan dari klaim.
        </p>
      </section>
    </div>
  );
}

function Funnel({ funnel }: { funnel: Record<string, number> }) {
  const rows = Object.entries(funnel);
  const total = rows.reduce((n, [, v]) => n + v, 0);
  const passed = funnel.lolos ?? 0;
  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <h2 className="text-sm font-semibold text-ink">Corong seleksi · {total} pool dicek sekarang</h2>
      <p className="mt-0.5 text-xs text-ink-3">Panda menyebut seleksi sebagai 70% pekerjaannya. Ini alasan tiap pool gugur.</p>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-2.5">
        <span className="text-sm font-medium text-emerald-300">Lolos semua filter</span>
        <span className="text-lg font-semibold tabular-nums text-emerald-300">{passed}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {rows
          .filter(([k]) => k !== "lolos")
          .map(([why, n]) => (
            <li key={why} className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-xs hover:bg-white/[0.02]">
              <span className="min-w-0 flex-1 truncate text-ink-3">{why}</span>
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/[0.06]">
                <span className="block h-full rounded-full bg-ink-3/50" style={{ width: `${total ? (n / total) * 100 : 0}%` }} />
              </span>
              <span className="w-8 text-right tabular-nums text-ink-2">{n}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}

function RunTable({ runs, empty }: { runs: Run[]; empty: string }) {
  if (runs.length === 0) return <p className="rounded-2xl border border-line bg-panel px-4 py-10 text-center text-sm text-ink-3">{empty}</p>;
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm tabular-nums">
          <thead className="text-[11px] uppercase tracking-wider text-ink-3">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 text-left font-medium">Pool</th>
              <th className="px-3 py-2.5 text-left font-medium">Status</th>
              <th className="px-3 py-2.5 text-right font-medium">Harga</th>
              <th className="px-3 py-2.5 text-right font-medium">Turun terdalam</th>
              <th className="px-3 py-2.5 text-right font-medium">Fee</th>
              <th className="px-3 py-2.5 text-right font-medium">Nilai posisi</th>
              <th className="px-3 py-2.5 text-right font-medium">Biaya</th>
              <th className="px-3 py-2.5 text-right font-medium">Hasil</th>
              <th className="px-4 py-2.5 text-right font-medium">Waktu</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((x) => {
              const st = REASON[x.status === "open" ? "open" : x.exit_reason ?? "time"] ?? REASON.time;
              const cost = (x.costs_usd ?? 0) + (x.rent_usd ?? 0);
              return (
                <tr key={x.id} className="border-b border-line/60 last:border-b-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/pool/${x.pool}`} className="font-medium text-ink hover:text-accent">
                      {x.name.replace("-", "/")}
                    </Link>
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
                  <td className="px-4 py-2.5 text-right text-[11px] text-ink-3">{fmtDateTime(x.closed_at ?? x.opened_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function PandaPage() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const [view, setView] = useUrlState<View>("view", "running", VIEWS);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${ENGINE_URL}/api/panda/paper`)
        .then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))))
        .then((b) => {
          if (cancelled) return;
          setR(b as Report);
          setError(false);
        })
        .catch(() => !cancelled && setError(true));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const p = r?.params;
  const closed = r?.counts.closed ?? 0;
  const open = r?.counts.open ?? 0;
  const running = r?.runs.filter((x) => x.status === "open") ?? [];
  const finished = r?.runs.filter((x) => x.status === "closed") ?? [];

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader
          title="Uji" accent="Panda Strat"
          subtitle="Paper, tanpa transaksi: seleksi ketat, range lebar satu sisi, keluar di pantulan pertama."
        />

        {error && !r && <p className="rounded-2xl border border-line bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>}

        {r && p && (
          <>
            <section className="overflow-hidden rounded-2xl border border-line bg-panel">
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
                  { value: "running", label: `Berjalan${open ? ` (${open})` : ""}` },
                  { value: "done", label: `Selesai${closed ? ` (${closed})` : ""}` },
                  { value: "funnel", label: "Corong seleksi" },
                  { value: "rules", label: "Aturan" },
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
              <RunTable runs={running} empty="Belum ada pool yang lolos seleksi sekaligus memberi sinyal entry. Engine memeriksa tiap 5 menit." />
            )}
            {view === "done" && <RunTable runs={finished} empty="Belum ada posisi yang ditutup." />}
            {view === "funnel" && <Funnel funnel={r.screening_funnel} />}
            {view === "rules" && <Rules p={p} approximations={r.approximations} />}
          </>
        )}
      </main>
    </div>
  );
}
