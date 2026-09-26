"use client";

import { useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../../lib/auto-refresh";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../../lib/format";
import { SkeletonStrip, SkeletonTable, SkeletonTabs } from "../skeleton";
import { Kpi } from "../panda-page";
import { EXIT_TONE } from "../../lib/exit-status";
import { useUrlState } from "../../lib/url-state";

type Level = { level: number; state: "buy" | "sell"; buy_price: number; sell_price: number; usd: number; sol: number; updated_at: number };
type Fill = { id: number; ts: number; level: number; side: string; price: number; sol: number; usd: number; profit_usd: number | null };
type Report = {
  params: { capital_usd: number; levels: number; step_pct: number; recenter_steps: number; tick_s: number };
  started_at: number | null;
  start_price: number | null;
  price: number;
  equity_usd: number;
  pnl_usd: number;
  hold_sol_usd: number | null;
  realized_usd: number;
  round_trips: number;
  sol_held: number;
  levels: Level[];
  fills: Fill[];
};

const tone = (n: number) => (n > 0.005 ? "text-emerald-300" : n < -0.005 ? "text-rose-300" : "text-ink-2");
const money = (n: number) => `${n >= 0 ? "+" : "−"}${usd.format(Math.abs(n))}`;


export default function SolGrid() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    fetch(`${ENGINE_URL}/api/paper/sol-grid`)
      .then((x) => (x.ok ? x.json() : Promise.reject(x.status)))
      .then((b: Report) => {
        setR(b);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  useAutoRefresh(load, 30_000);
  useEffect(load, [load]);
  const [view, setView] = useUrlState<"berjalan" | "selesai" | "aturan">("grid", "berjalan", ["berjalan", "selesai", "aturan"]);

  if (!r && error) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>;
  if (!r)
    return (
      <>
        <SkeletonStrip count={4} />
        <SkeletonTabs count={3} />
        <SkeletonTable rows={5} columns={5} title={false} />
      </>
    );
  const p = r.params;
  const vsHold = r.hold_sol_usd == null ? null : r.equity_usd - r.hold_sol_usd;
  const sells = r.fills.filter((f) => f.side === "sell");
  const holding = r.levels.filter((l) => l.state === "sell").length;
  const perRound = r.round_trips ? r.realized_usd / r.round_trips : null;

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
        <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
          <Kpi
            label="Hasil bersih"
            value={money(r.pnl_usd)}
            hint={`terealisasi ${money(r.realized_usd)}${vsHold == null ? "" : ` · vs pegang SOL ${money(vsHold)}`}`}
            cls={tone(r.pnl_usd)}
          />
          <Kpi label="Untung per putaran" value={perRound == null ? "–" : money(perRound)} hint="satu kali beli lalu jual, setelah biaya jaringan" />
          <Kpi label="Win rate" value={r.round_trips ? "100%" : "–"} hint={`${holding} level memegang SOL · tanpa stop-loss`} />
          <Kpi label="Modal per level" value={usd.format(p.capital_usd / p.levels)} hint={`${p.levels} level · SOL $${fmtNum(r.price, 2)}`} />
        </div>
      </section>

      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Tampilan grid">
        {(
          [
            { value: "berjalan", label: `Berjalan (${holding})` },
            { value: "selesai", label: `Selesai (${r.round_trips})` },
            { value: "aturan", label: "Aturan" },
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
        <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm tabular-nums">
              <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2.5 text-left font-medium">Level</th>
                  <th className="px-3 py-2.5 text-left font-medium">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium">Beli di</th>
                  <th className="px-3 py-2.5 text-right font-medium">Jual di</th>
                  <th className="px-3 py-2.5 text-right font-medium">Isi</th>
                  <th className="px-4 py-2.5 text-right font-medium">Waktu</th>
                </tr>
              </thead>
              <tbody>
                {r.levels.map((lv) => (
                  <tr key={lv.level} className="border-b border-line/60 last:border-b-0">
                    <td className="px-4 py-2.5 font-medium text-ink">
                      #{lv.level} · −{fmtNum(lv.level * p.step_pct, 0)}%
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${lv.state === "sell" ? EXIT_TONE.running : EXIT_TONE.stopped}`}>
                        {lv.state === "sell" ? "Pegang SOL, tunggu jual" : "Tunggu beli"}
                      </span>
                    </td>
                    <td className={`px-3 py-2.5 text-right ${lv.state === "buy" ? "text-ink" : "text-ink-3"}`}>${fmtNum(lv.buy_price, 2)}</td>
                    <td className={`px-3 py-2.5 text-right ${lv.state === "sell" ? "text-ink" : "text-ink-3"}`}>${fmtNum(lv.sell_price, 2)}</td>
                    <td className="px-3 py-2.5 text-right text-ink-2">{lv.state === "buy" ? usd.format(lv.usd) : `${fmtNum(lv.sol, 4)} SOL`}</td>
                    <td className="px-4 py-2.5 text-right text-[11px] text-ink-3">{fmtDateTime(lv.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view === "selesai" &&
        (sells.length === 0 ? (
          <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center text-sm text-ink-3">
            Belum ada putaran yang selesai. Dicek tiap {p.tick_s} detik: order beli terdekat {p.step_pct}% di bawah harga.
          </p>
        ) : (
          <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm tabular-nums">
                <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2.5 text-left font-medium">Level</th>
                    <th className="px-3 py-2.5 text-left font-medium">Status</th>
                    <th className="px-3 py-2.5 text-right font-medium">Jual di</th>
                    <th className="px-3 py-2.5 text-right font-medium">SOL</th>
                    <th className="px-3 py-2.5 text-right font-medium">Hasil</th>
                    <th className="px-4 py-2.5 text-right font-medium">Waktu</th>
                  </tr>
                </thead>
                <tbody>
                  {sells.map((f) => (
                    <tr key={f.id} className="border-b border-line/60 last:border-b-0">
                      <td className="px-4 py-2.5 font-medium text-ink">#{f.level}</td>
                      <td className="px-3 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${EXIT_TONE.planned}`}>Target tercapai</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-ink-2">${fmtNum(f.price, 2)}</td>
                      <td className="px-3 py-2.5 text-right text-ink-2">{fmtNum(f.sol, 4)}</td>
                      <td className={`px-3 py-2.5 text-right font-semibold ${tone(f.profit_usd ?? 0)}`}>{money(f.profit_usd ?? 0)}</td>
                      <td className="px-4 py-2.5 text-right text-[11px] text-ink-3">{fmtDateTime(f.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

      {view === "aturan" && (
        <div className="space-y-5">
          <section className="grid gap-4 rounded-2xl border border-white/[0.06] bg-panel p-4 md:grid-cols-2">
            {[
              {
                title: "Masuk",
                items: [
                  `Modal ${usd.format(p.capital_usd)} USDC dibagi rata ke ${p.levels} level (${usd.format(p.capital_usd / p.levels)} per level).`,
                  `Order beli dipasang ${p.step_pct}%, ${p.step_pct * 2}%, … sampai ${p.step_pct * p.levels}% di bawah harga SOL.`,
                  `Grid digeser naik bila SOL naik ${p.recenter_steps} langkah di atas order teratas dan semua level sedang di USDC.`,
                ],
              },
              {
                title: "Keluar",
                items: [
                  `Setiap level yang terbeli langsung dipasang jual ${p.step_pct}% di atas harga belinya.`,
                  "Setelah terjual, level itu menunggu beli lagi di harga yang sama.",
                  "Tanpa stop-loss: saat SOL turun jauh, level memegang SOL sampai harganya kembali.",
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
          <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3 text-sm leading-6 text-ink-3">
            Harga dibaca tiap {p.tick_s} detik dari pool SOL-USDC terbesar di Meteora. Bonus fee Meteora saat order terisi tidak dihitung, jadi hasil
            sedikit di bawah kenyataan. Biaya jaringan dihitung per order.{r.started_at ? ` Mulai ${fmtDateTime(r.started_at)} WIB.` : ""}
          </p>
        </div>
      )}
    </>
  );
}
