"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../../lib/format";
import { SkeletonBox } from "../skeleton";

type Lp = {
  wallet: string;
  positions: number;
  value_usd: number;
  deposit_usd: number;
  pnl_usd: number;
  fees_usd: number;
  min_price: number | null;
  max_price: number | null;
  created_at: number | null;
  leader_rank: number | null;
  leader_win_rate: number | null;
  leader_meets: boolean | null;
  followed: boolean;
  mine: boolean;
  share_pct: number | null;
};
type Report = { count: number; wallets: Lp[]; total_usd: number };

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const money = (n: number) => `${n >= 0 ? "+" : "−"}${usd.format(Math.abs(n))}`;
const tone = (n: number) => (n > 0.005 ? "text-emerald-300" : n < -0.005 ? "text-rose-300" : "text-ink-2");
const price = (n: number | null) => (n == null ? "–" : n.toPrecision(n >= 1 ? 5 : 4));

/** Who provides this pool's liquidity: every wallet with an open position, its size and range, and labels for the
 * wallets this app knows (leaderboard, Copy LP, yours). One wallet holding it all is flagged: it can leave at once. */
export default function PoolLps({ address }: { address: string }) {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`${ENGINE_URL}/api/pools/${address}/lps`)
      .then((x) => (x.ok ? x.json() : Promise.reject(x.status)))
      .then((b: Report) => !cancelled && setR(b))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [address]);

  const top = r?.wallets[0];
  const concentrated = top && top.share_pct != null && top.share_pct >= 80;

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Wallet LP di pool ini</h2>
          <p className="text-xs text-ink-3">Siapa yang memasang likuiditas sekarang, dibaca on-chain · diperbarui tiap 5 menit</p>
        </div>
        {r && (
          <span className="text-xs text-ink-3">
            {r.count} wallet · {usd.format(r.total_usd)}
          </span>
        )}
      </div>

      {!r && !error && (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <SkeletonBox key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      )}
      {error && <p className="px-4 py-8 text-center text-sm text-ink-3">Daftar wallet LP belum bisa dibaca.</p>}

      {r && (
        <>
          {concentrated && (
            <div className="border-b border-rose-500/30 bg-rose-500/[0.07] px-4 py-3 text-sm text-rose-100">
              <b>⚠ Likuiditas terpusat:</b> {r.count === 1 ? "hanya satu wallet" : `wallet ${short(top!.wallet)}`} memegang{" "}
              {fmtNum(top!.share_pct ?? 0, 0)}% likuiditas pool ini. Kalau wallet itu (sering kali pembuat pool) menarik posisinya, pool hampir kosong
              dan harga bisa bergerak liar; posisimu yang tersisa akan menanggungnya.
            </div>
          )}
          {r.wallets.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-3">Tidak ada posisi LP terbuka.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm tabular-nums">
                <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2.5 text-left font-medium">Wallet</th>
                    <th className="px-3 py-2.5 text-right font-medium">Nilai</th>
                    <th className="px-3 py-2.5 text-right font-medium">Bagian</th>
                    <th className="px-3 py-2.5 text-right font-medium">Range harga</th>
                    <th className="px-3 py-2.5 text-right font-medium">PnL</th>
                    <th className="px-4 py-2.5 text-right font-medium">Dibuka</th>
                  </tr>
                </thead>
                <tbody>
                  {r.wallets.map((w) => (
                    <tr key={w.wallet} className={`border-b border-line/60 last:border-b-0 ${w.mine ? "bg-accent/[0.06]" : ""}`}>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <a href={`https://solscan.io/account/${w.wallet}`} target="_blank" rel="noreferrer" className="font-mono font-medium text-ink hover:text-accent">
                            {short(w.wallet)}
                          </a>
                          {w.mine && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">Wallet kamu</span>}
                          {w.leader_rank != null && (
                            <Link
                              href="/leaders"
                              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                w.leader_meets ? "bg-emerald-400/10 text-emerald-300" : "bg-white/[0.06] text-ink-2"
                              }`}
                            >
                              LP teratas #{w.leader_rank}
                              {w.leader_win_rate != null ? ` · ${fmtNum(w.leader_win_rate * 100, 0)}%` : ""}
                            </Link>
                          )}
                          {w.followed && <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">Diikuti Copy LP</span>}
                          {r.count === 1 && <span className="rounded-full bg-rose-400/10 px-2 py-0.5 text-[11px] font-medium text-rose-300">LP tunggal</span>}
                        </div>
                        <div className="text-[11px] text-ink-3">{w.positions} posisi</div>
                      </td>
                      <td className="px-3 py-2.5 text-right text-ink">{usd.format(w.value_usd)}</td>
                      <td className={`px-3 py-2.5 text-right ${w.share_pct != null && w.share_pct >= 80 ? "font-semibold text-rose-300" : "text-ink-2"}`}>
                        {w.share_pct == null ? "–" : `${fmtNum(w.share_pct, 0)}%`}
                      </td>
                      <td className="px-3 py-2.5 text-right text-[12px] text-ink-2">
                        {price(w.min_price)} – {price(w.max_price)}
                      </td>
                      <td className={`px-3 py-2.5 text-right ${tone(w.pnl_usd)}`}>
                        {money(w.pnl_usd)}
                        <div className="text-[11px] text-ink-3">fee {usd.format(w.fees_usd)}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-[11px] text-ink-3">{w.created_at ? fmtDateTime(w.created_at) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
