"use client";

import { useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../../lib/auto-refresh";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../../lib/format";
import { SkeletonTable, SkeletonTiles } from "../skeleton";

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
const SIDE: Record<string, string> = { buy: "Beli", sell: "Jual", start: "Mulai", recenter: "Grid digeser naik" };

function Tile({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

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

  if (!r && error) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>;
  if (!r)
    return (
      <>
        <SkeletonTiles count={4} />
        <SkeletonTable rows={5} columns={5} title={false} />
      </>
    );
  const p = r.params;
  const vsHold = r.hold_sol_usd == null ? null : r.equity_usd - r.hold_sol_usd;
  const trades = r.fills.filter((f) => f.side !== "start");

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
        <div className="grid grid-cols-2 gap-px bg-line/40 lg:grid-cols-4">
          <Tile
            label="Nilai sekarang"
            value={usd.format(r.equity_usd)}
            hint={`${money(r.pnl_usd)} dari modal ${usd.format(p.capital_usd)}`}
            cls={tone(r.pnl_usd)}
          />
          <Tile label="Untung terealisasi" value={money(r.realized_usd)} hint={`${r.round_trips} kali beli-jual selesai`} cls={tone(r.realized_usd)} />
          <Tile
            label="Dibanding pegang SOL"
            value={vsHold == null ? "–" : money(vsHold)}
            hint={r.hold_sol_usd == null ? undefined : `pegang SOL sejak awal = ${usd.format(r.hold_sol_usd)}`}
            cls={vsHold == null ? undefined : tone(vsHold)}
          />
          <Tile
            label="SOL dipegang"
            value={`${fmtNum(r.sol_held, 3)} SOL`}
            hint={`harga sekarang $${fmtNum(r.price, 2)}${r.start_price ? ` · awal $${fmtNum(r.start_price, 2)}` : ""}`}
          />
        </div>
        <p className="border-t border-line px-4 py-3 text-xs leading-5 text-ink-3">
          {p.levels} order beli, {p.step_pct}% berjarak di bawah harga ({usd.format(p.capital_usd / p.levels)} per level). Yang terbeli dijual {p.step_pct}%
          di atas harga belinya, lalu menunggu beli lagi di harga yang sama. Grid digeser naik bila harga naik {p.recenter_steps} langkah di atas order
          teratas dan semua level sedang di USDC. Tanpa stop-loss. Bonus fee Meteora saat order terisi tidak dihitung, jadi hasil sedikit di bawah
          kenyataan.{r.started_at ? ` Mulai ${fmtDateTime(r.started_at)} WIB.` : ""}
        </p>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">Level grid</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm tabular-nums">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3">
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left font-medium">Level</th>
                <th className="px-3 py-2 text-left font-medium">Menunggu</th>
                <th className="px-3 py-2 text-right font-medium">Beli di</th>
                <th className="px-3 py-2 text-right font-medium">Jual di</th>
                <th className="px-4 py-2 text-right font-medium">Isi</th>
              </tr>
            </thead>
            <tbody>
              {r.levels.map((lv) => (
                <tr key={lv.level} className="border-b border-line/60 last:border-b-0">
                  <td className="px-4 py-2.5 text-ink">#{lv.level} · −{fmtNum(lv.level * p.step_pct, 0)}%</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        lv.state === "buy" ? "bg-sky-400/10 text-sky-300" : "bg-amber-400/10 text-amber-300"
                      }`}
                    >
                      {lv.state === "buy" ? "Beli" : "Jual"}
                    </span>
                  </td>
                  <td className={`px-3 py-2.5 text-right ${lv.state === "buy" ? "text-ink" : "text-ink-3"}`}>${fmtNum(lv.buy_price, 2)}</td>
                  <td className={`px-3 py-2.5 text-right ${lv.state === "sell" ? "text-ink" : "text-ink-3"}`}>${fmtNum(lv.sell_price, 2)}</td>
                  <td className="px-4 py-2.5 text-right text-ink-2">{lv.state === "buy" ? usd.format(lv.usd) : `${fmtNum(lv.sol, 4)} SOL`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">Order terisi</h2>
        {trades.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-3">Belum ada order yang terisi. Order beli terdekat 1% di bawah harga.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {trades.slice(0, 50).map((f) => (
              <li key={f.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-2.5 text-sm tabular-nums">
                <span className="w-32 text-[11px] text-ink-3">{fmtDateTime(f.ts)}</span>
                <span className="text-ink-2">
                  {SIDE[f.side] ?? f.side}
                  {f.level ? ` · level #${f.level}` : ""} di ${fmtNum(f.price, 2)}
                </span>
                <span className={f.profit_usd == null ? "text-ink-3" : tone(f.profit_usd)}>{f.profit_usd == null ? "" : money(f.profit_usd)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
