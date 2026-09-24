"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../lib/format";
import TopBar from "./top-bar";
import PageHeader from "./page-header";

type Run = {
  id: number;
  pool: string;
  name: string;
  quote: string;
  base_fee_pct: number;
  status: "open" | "closed";
  exit_reason: string | null;
  pool_age_min: number | null;
  size_usd: number;
  fees_usd: number;
  lp_value_usd: number;
  price_change_pct: number;
  in_range_pct: number | null;
  last_tvl: number | null;
  costs_usd: number | null;
  create_cost_usd: number | null;
  pnl_usd: number;
  opened_at: number;
  closed_at: number | null;
};
type Report = {
  started_at: number | null;
  params: {
    size_sol: number;
    max_open: number;
    max_pool_age_min: number;
    fee_min_pct: number;
    min_tvl_usd: number;
    min_volume_30m_usd: number;
    range_low: number;
    range_high: number;
    stop_pct: number;
    max_hold_h: number;
    create_cost_sol: number;
    swap_cost_pct: number;
    fees_dried_pct: number;
  };
  counts: Record<string, number>;
  pnl_usd: number;
  pnl_without_create_usd: number;
  fees_usd: number;
  capital_usd: number;
  win_rate: number | null;
  win_rate_without_create: number | null;
  runs: Run[];
};

const REASON: Record<string, { label: string; cls: string }> = {
  open: { label: "Berjalan", cls: "bg-sky-400/10 text-sky-300" },
  stop: { label: "Cut loss", cls: "bg-rose-400/10 text-rose-300" },
  below_range: { label: "Jatuh keluar range", cls: "bg-rose-400/10 text-rose-300" },
  fees_dried: { label: "Fee mengering", cls: "bg-amber-400/10 text-amber-300" },
  time: { label: "24 jam", cls: "bg-white/[0.06] text-ink-2" },
  vanished: { label: "Pool hilang", cls: "bg-rose-400/10 text-rose-300" },
};
const money = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const tone = (v: number) => (v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-ink-2");

function useReport() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${ENGINE_URL}/api/pool-lab/paper`)
        .then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))))
        .then((b) => {
          if (!cancelled) {
            setR(b as Report);
            setError(false);
          }
        })
        .catch(() => !cancelled && setError(true));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  return { r, error };
}

function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-[#0e1217] px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

export default function PoolLabPage() {
  const { r, error } = useReport();
  const p = r?.params;
  const closed = r?.counts.closed ?? 0;
  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader title="Uji pembuat pool" subtitle="Paper, tanpa transaksi: jadi LP pertama di pool baru ber-fee tinggi." />

        {error && !r && (
          <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>
        )}
        {r && p && (
          <>
            <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97]">
              <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
                <Kpi
                  label="Hasil bersih sebagai pembuat"
                  value={closed ? money(r.pnl_usd) : "–"}
                  hint={closed ? `dari ${closed} uji selesai · modal ${usd.format(r.capital_usd)}` : "belum ada uji selesai"}
                  cls={closed ? tone(r.pnl_usd) : undefined}
                />
                <Kpi
                  label="Tanpa biaya buat pool"
                  value={closed ? money(r.pnl_without_create_usd) : "–"}
                  hint="= ikut jadi LP pertama di pool orang"
                  cls={closed ? tone(r.pnl_without_create_usd) : undefined}
                />
                <Kpi
                  label="Win rate"
                  value={r.win_rate == null ? "–" : `${fmtNum(r.win_rate * 100, 0)}%`}
                  hint={r.win_rate_without_create == null ? undefined : `${fmtNum(r.win_rate_without_create * 100, 0)}% tanpa biaya buat pool`}
                />
                <Kpi label="Fee terkumpul" value={closed ? usd.format(r.fees_usd) : "–"} hint={`${r.counts.open ?? 0} uji masih berjalan`} />
              </div>
              <p className="border-t border-line px-4 py-3 text-xs leading-5 text-ink-3">
                {closed < 20
                  ? `Kumpulkan minimal 20 uji selesai (3–5 hari) sebelum menyimpulkan. Satu pool yang meledak bisa menutupi banyak yang rugi, atau sebaliknya.`
                  : `Lihat kolom Hasil per baris: bila untung hanya datang dari 1–2 pool, strategi ini belum bisa diandalkan.`}
                {r.started_at ? ` Mulai ${fmtDateTime(r.started_at)} WIB.` : " Menunggu pool pertama yang memenuhi syarat."}
              </p>
            </section>

            <section className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-3.5 text-xs leading-5 text-ink-2">
              <h2 className="mb-1.5 text-sm font-semibold text-ink">Aturan uji</h2>
              <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                <li>
                  <span className="text-ink-3">Masuk:</span> pool DLMM umur ≤ {p.max_pool_age_min} menit, fee ≥ {p.fee_min_pct}%, quote SOL/USDC, TVL ≥{" "}
                  {usd.format(p.min_tvl_usd)}, volume 30 menit ≥ {usd.format(p.min_volume_30m_usd)}, token tanpa freeze authority.
                </li>
                <li>
                  <span className="text-ink-3">Posisi:</span> {p.size_sol} SOL, Spot {p.range_low}× – {p.range_high}× harga masuk, maks {p.max_open} sekaligus.
                </li>
                <li>
                  <span className="text-ink-3">Fee:</span> fee asli pool × bagianmu (nilai posisi ÷ (nilai posisi + TVL pool)), hanya saat harga di dalam range.
                </li>
                <li>
                  <span className="text-ink-3">Keluar:</span> rugi {p.stop_pct}%, harga di bawah range, fee &lt; {p.fees_dried_pct}%/jam setelah 2 jam, atau {p.max_hold_h} jam.
                </li>
                <li>
                  <span className="text-ink-3">Biaya:</span> buat pool {p.create_cost_sol} SOL (sewa yang tidak kembali), swap {p.swap_cost_pct}% masuk dan keluar,
                  biaya jaringan.
                </li>
                <li>
                  <span className="text-ink-3">Diperiksa:</span> tiap 5 menit dengan data Meteora.
                </li>
              </ul>
            </section>

            <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[880px] text-sm tabular-nums">
                  <thead className="text-[11px] uppercase tracking-wider text-ink-3">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2.5 text-left font-medium">Pool</th>
                      <th className="px-3 py-2.5 text-left font-medium">Status</th>
                      <th className="px-3 py-2.5 text-right font-medium">Harga</th>
                      <th className="px-3 py-2.5 text-right font-medium">Di range</th>
                      <th className="px-3 py-2.5 text-right font-medium">Fee</th>
                      <th className="px-3 py-2.5 text-right font-medium">Nilai LP</th>
                      <th className="px-3 py-2.5 text-right font-medium">Biaya</th>
                      <th className="px-3 py-2.5 text-right font-medium">Hasil</th>
                      <th className="px-4 py-2.5 text-right font-medium">Waktu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.runs.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-ink-3">
                          Belum ada pool baru yang memenuhi syarat. Engine memeriksa tiap 5 menit.
                        </td>
                      </tr>
                    )}
                    {r.runs.map((x) => {
                      const st = REASON[x.status === "open" ? "open" : x.exit_reason ?? "time"] ?? REASON.time;
                      const cost = (x.costs_usd ?? 0) + (x.create_cost_usd ?? 0);
                      return (
                        <tr key={x.id} className="border-b border-line/60 last:border-b-0">
                          <td className="px-4 py-2.5">
                            <Link href={`/pool/${x.pool}`} className="font-medium text-ink hover:text-accent">
                              {x.name.replace("-", "/")}
                            </Link>
                            <div className="text-[11px] text-ink-3">
                              fee {fmtNum(x.base_fee_pct, 1)}% · umur {fmtNum(x.pool_age_min ?? 0, 0)} mnt saat masuk · TVL{" "}
                              {x.last_tvl == null ? "–" : usd.format(x.last_tvl)}
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
                          </td>
                          <td className={`px-3 py-2.5 text-right ${tone(x.price_change_pct)}`}>
                            {x.price_change_pct >= 0 ? "+" : ""}
                            {fmtNum(x.price_change_pct, 1)}%
                          </td>
                          <td className="px-3 py-2.5 text-right text-ink-2">{x.in_range_pct == null ? "–" : `${fmtNum(x.in_range_pct, 0)}%`}</td>
                          <td className="px-3 py-2.5 text-right text-emerald-300">+{usd.format(x.fees_usd)}</td>
                          <td className="px-3 py-2.5 text-right text-ink-2">
                            {usd.format(x.lp_value_usd)}
                            <div className="text-[11px] text-ink-3">dari {usd.format(x.size_usd)}</div>
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
