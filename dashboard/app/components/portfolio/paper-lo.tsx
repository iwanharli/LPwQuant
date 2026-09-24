"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum } from "../../lib/format";

type Order = {
  id: number;
  name: string;
  quote: string;
  status: "waiting" | "holding" | "closed" | "expired";
  step_pct: number;
  buy_price: number;
  sell_price: number;
  stop_price: number;
  size_quote: number;
  exit_price: number | null;
  exit_reason: string | null;
  pnl_quote: number | null;
  pnl_sol: number | null;
  replay_pct: number | null;
  opened_at: number;
  filled_at: number | null;
  closed_at: number | null;
};
type Report = {
  started_at: number | null;
  size_sol: number;
  counts: Record<string, number>;
  pnl_sol: number;
  win_rate: number | null;
  avg_trade_pct: number | null;
  orders: Order[];
};

const STATUS: Record<string, { label: string; cls: string }> = {
  waiting: { label: "Menunggu beli", cls: "bg-sky-400/10 text-sky-300" },
  holding: { label: "Memegang", cls: "bg-amber-400/10 text-amber-300" },
  target: { label: "Target ✓", cls: "bg-emerald-400/10 text-emerald-300" },
  stop: { label: "Cut loss", cls: "bg-rose-400/10 text-rose-300" },
  time: { label: "Tutup 24 jam", cls: "bg-white/[0.06] text-ink-2" },
  expired: { label: "Tidak terisi", cls: "bg-white/[0.04] text-ink-3" },
};
const px = (v: number) => (v >= 1 ? fmtNum(v, 4) : v.toExponential(3));
const sol = (v: number) => `${v >= 0 ? "+" : "−"}${fmtNum(Math.abs(v), 4)} SOL`;
const tone = (v: number) => (v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-ink-2");

/** The engine's paper run of the recommended rule: is buy-low / sell-high actually making money here? */
export default function PaperLimitOrders() {
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${ENGINE_URL}/api/limit-order/paper`)
        .then((x) => (x.ok ? x.json() : null))
        .then((b) => !cancelled && b && setR(b as Report))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!r) return null;
  const c = r.counts;
  const done = (c.closed ?? 0) + (c.expired ?? 0);
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Uji coba engine · paper, tanpa transaksi</h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Aturan rekomendasi dijalankan otomatis dengan harga live, {r.size_sol} SOL per order
            {r.started_at ? ` · mulai ${fmtDateTime(r.started_at)} WIB` : ""}. Bonus fee maker tidak dihitung.
          </p>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-semibold tabular-nums ${tone(r.pnl_sol)}`}>{sol(r.pnl_sol)}</div>
          <div className="text-[11px] text-ink-3">hasil order yang sudah selesai</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-line/40 text-center sm:grid-cols-5">
        {[
          { label: "Menunggu beli", v: c.waiting ?? 0 },
          { label: "Memegang", v: c.holding ?? 0 },
          { label: "Target kena", v: c.target ?? 0, cls: "text-emerald-300" },
          { label: "Cut loss / 24 jam", v: (c.stop ?? 0) + (c.time ?? 0), cls: "text-rose-300" },
          { label: "Tidak terisi", v: c.expired ?? 0 },
        ].map((k) => (
          <div key={k.label} className="bg-panel px-3 py-3">
            <div className={`text-xl font-semibold tabular-nums ${k.cls ?? "text-ink"}`}>{k.v}</div>
            <div className="text-[11px] text-ink-3">{k.label}</div>
          </div>
        ))}
      </div>

      <p className="border-b border-line px-4 py-2.5 text-xs text-ink-3">
        {done === 0
          ? "Belum ada order yang selesai. Kumpulkan 2–3 hari sebelum menyimpulkan; satu-dua order belum berarti apa-apa."
          : `${done} order selesai · win rate ${r.win_rate == null ? "–" : `${fmtNum(r.win_rate * 100, 0)}%`} · rata-rata per trade ${
              r.avg_trade_pct == null ? "–" : `${r.avg_trade_pct >= 0 ? "+" : ""}${fmtNum(r.avg_trade_pct, 2)}%`
            }`}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm tabular-nums">
          <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 text-left font-medium">Pool</th>
              <th className="px-3 py-2.5 text-left font-medium">Status</th>
              <th className="px-3 py-2.5 text-right font-medium">Beli · jual · cut</th>
              <th className="px-3 py-2.5 text-right font-medium">Keluar</th>
              <th className="px-3 py-2.5 text-right font-medium">Hasil</th>
              <th className="px-4 py-2.5 text-right font-medium">Waktu</th>
            </tr>
          </thead>
          <tbody>
            {r.orders.map((o) => {
              const st = STATUS[o.status === "closed" ? o.exit_reason ?? "time" : o.status] ?? STATUS.waiting;
              return (
                <tr key={o.id} className="border-b border-line/60 last:border-b-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-ink">{o.name.replace("-", "/")}</div>
                    <div className="text-[11px] text-ink-3">langkah {fmtNum(o.step_pct, 1)}% · uji 48j {o.replay_pct == null ? "–" : `${fmtNum(o.replay_pct, 1)}%`}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs text-ink-2">
                    {px(o.buy_price)} · {px(o.sell_price)} · {px(o.stop_price)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs text-ink-2">{o.exit_price ? px(o.exit_price) : "–"}</td>
                  <td className={`px-3 py-2.5 text-right font-medium ${tone(o.pnl_sol ?? 0)}`}>{o.pnl_sol == null ? "–" : sol(o.pnl_sol)}</td>
                  <td className="px-4 py-2.5 text-right text-[11px] text-ink-3">
                    {fmtDateTime(o.closed_at ?? o.filled_at ?? o.opened_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
