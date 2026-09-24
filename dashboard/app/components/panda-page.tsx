"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, usd, usdCompact } from "../lib/format";
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
    size_sol: number;
    max_open: number;
    range_low_pct: number;
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
    <div className="bg-[#0e1217] px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

/** Paper test of the Panda Strat, with the screening funnel that the strategy itself calls 70% of the work. */
export default function PandaPage() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${ENGINE_URL}/api/panda/paper`)
        .then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))))
        .then((b) => !cancelled && (setR(b as Report), setError(false)))
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
  const funnel = Object.entries(r?.screening_funnel ?? {});
  const passed = r?.screening_funnel?.lolos ?? 0;
  const screened = funnel.reduce((n, [, v]) => n + v, 0);

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader title="Uji Panda Strat" subtitle="Paper, tanpa transaksi: seleksi ketat, range lebar satu sisi, keluar di pantulan pertama." />

        {error && !r && <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>}

        {r && p && (
          <>
            <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97]">
              <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
                <Kpi
                  label="Hasil bersih"
                  value={closed ? money(r.pnl_usd) : "–"}
                  hint={closed ? `${closed} posisi selesai · modal ${usd.format(r.capital_usd)}` : "belum ada yang selesai"}
                  cls={closed ? tone(r.pnl_usd) : undefined}
                />
                <Kpi
                  label="Sewa posisi (dikembalikan)"
                  value={`${p.position_rent_sol} SOL`}
                  hint={`terkunci selama posisi terbuka, kembali saat ditutup`}
                />
                <Kpi label="Win rate" value={r.win_rate == null ? "–" : `${fmtNum(r.win_rate * 100, 0)}%`} hint={`${r.counts.open ?? 0} posisi berjalan`} />
                <Kpi label="Fee terkumpul" value={closed ? usd.format(r.fees_usd) : "–"} hint="bagian kita dari fee pool, saat harga di dalam range" />
              </div>
              <p className="border-t border-line px-4 py-3 text-xs leading-5 text-ink-3">
                Semua klaim performa Panda Strat di media sosial belum pernah diverifikasi on-chain. Uji ini menjalankan aturannya dengan harga dan fee
                Meteora yang sebenarnya, supaya angkanya datang dari data, bukan dari klaim.
              </p>
            </section>

            <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
              <section className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-3.5">
                <h2 className="text-sm font-semibold text-ink">Corong seleksi ({screened} pool dicek sekarang)</h2>
                <p className="mt-0.5 text-xs text-ink-3">Panda menyebut seleksi sebagai 70% pekerjaannya. Ini alasan tiap pool gugur.</p>
                <ul className="mt-3 space-y-1 text-xs">
                  <li className="flex items-center justify-between gap-3 rounded-lg bg-emerald-400/[0.07] px-2.5 py-1.5">
                    <span className="text-emerald-300">Lolos semua filter</span>
                    <span className="font-semibold tabular-nums text-emerald-300">{passed}</span>
                  </li>
                  {funnel
                    .filter(([k]) => k !== "lolos")
                    .map(([why, n]) => (
                      <li key={why} className="flex items-center justify-between gap-3 px-2.5 py-1 text-ink-3">
                        <span className="truncate">{why}</span>
                        <span className="tabular-nums">{n}</span>
                      </li>
                    ))}
                </ul>
              </section>

              <section className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-3.5 text-xs leading-5 text-ink-2">
                <h2 className="text-sm font-semibold text-ink">Aturan yang dijalankan</h2>
                <ul className="mt-2 space-y-1">
                  <li>
                    <span className="text-ink-3">Seleksi:</span> market cap ≥ {usdCompact.format(p.min_market_cap)}, volume 24j ≥{" "}
                    {usdCompact.format(p.min_volume_24h)}, fee/TVL ≥ {p.min_fee_tvl_24h}%, holder ≥ {p.min_holders}, top-10 &lt; {p.max_top10_pct}%,
                    insider &lt; 10%, bundling &lt; 60%, lolos keamanan, volume organik.
                  </li>
                  <li>
                    <span className="text-ink-3">Entry:</span> harga menembus ke atas Supertrend 15 menit dan masih dalam {p.near_high_pct}% dari puncak.
                  </li>
                  <li>
                    <span className="text-ink-3">Posisi:</span> {p.size_sol} SOL, hanya SOL/USDC, tersebar rata dari harga sampai {p.range_low_pct}% di
                    bawahnya pada {p.bins} bin, maks {p.max_open} posisi.
                  </li>
                  <li>
                    <span className="text-ink-3">Exit:</span> RSI(2) &gt; 90 ditambah harga di atas upper Bollinger, atau RSI(2) &gt; 90 ditambah batang
                    hijau pertama MACD. Ditutup juga bila volume mati atau lewat {p.max_hold_h} jam.
                  </li>
                  <li>
                    <span className="text-ink-3">Biaya:</span> swap keluar 1% dari token tersisa dan biaya jaringan. Sewa posisi {p.position_rent_sol} SOL
                    dikembalikan saat tutup; sewa bin array {p.new_bin_array_sol} SOL hanya kalau range membuat bin baru.
                  </li>
                </ul>
                <h3 className="mt-3 text-[11px] uppercase tracking-wider text-ink-3">Yang tidak bisa ditiru persis</h3>
                <ul className="mt-1 space-y-0.5 text-[11px] text-ink-3">
                  {r.approximations.map((a) => (
                    <li key={a}>· {a}</li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm tabular-nums">
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
                    {r.runs.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-ink-3">
                          Belum ada pool yang lolos seleksi sekaligus memberi sinyal entry. Engine memeriksa tiap 5 menit.
                        </td>
                      </tr>
                    )}
                    {r.runs.map((x) => {
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
          </>
        )}
      </main>
    </div>
  );
}
