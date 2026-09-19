"use client";

import { useEffect, useMemo, useState } from "react";
import { ENGINE_URL, fmtNum, usd } from "../../lib/format";
import { useTokenInfo } from "./activity-feed";

type Day = { day: string; claims: number; tokens: { mint: string; symbol: string; amount: number }[] };

// Priced reliably at today's rate: a SOL or USDC fee is worth about the same now as when it was claimed.
const STABLE_VALUE = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]);

const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

/**
 * Fees claimed per day as bars, back to the first claim in the history. Each bar splits into what is priced
 * reliably (SOL, USDC) and memecoin fees valued at today's price, which can be far from their worth at the time.
 */
export default function ClaimsChart({ wallet }: { wallet: string }) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${ENGINE_URL}/api/portfolio/claims-daily?wallet=${wallet}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => !cancelled && body && setDays(body.days as Day[]))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const mints = useMemo(() => (days ?? []).flatMap((d) => d.tokens.map((t) => t.mint)), [days]);
  const info = useTokenInfo(mints);

  const bars = useMemo(
    () =>
      (days ?? []).map((d) => {
        let stable = 0;
        let meme = 0;
        const priced = d.tokens.map((t) => {
          const p = info[t.mint]?.price;
          const v = p == null ? null : p * t.amount;
          if (v != null) {
            if (STABLE_VALUE.has(t.mint)) stable += v;
            else meme += v;
          }
          return { ...t, usd: v };
        });
        return { ...d, stable, meme, total: stable + meme, priced: priced.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)) };
      }),
    [days, info],
  );

  if (!days) return <p className="px-2 py-8 text-sm text-ink-3">Memuat…</p>;
  if (bars.length === 0) return <p className="px-2 py-8 text-sm text-ink-3">Belum ada claim fee di riwayat.</p>;

  const max = Math.max(...bars.map((b) => b.total), 1e-9);
  const total = bars.reduce((n, b) => n + b.total, 0);
  const stableTotal = bars.reduce((n, b) => n + b.stable, 0);
  const sel = hover != null ? bars[hover] : bars[bars.length - 1];

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_17rem]">
      <div>
        <div className="flex h-48 items-end gap-2 border-b border-white/[0.06] px-1" onMouseLeave={() => setHover(null)}>
          {bars.map((b, i) => {
            const active = sel === b;
            return (
              <button
                key={b.day}
                type="button"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                aria-label={`${dayLabel(b.day)}: ${usd.format(b.total)}`}
                className="group flex h-full min-w-0 flex-1 flex-col justify-end"
              >
                <div
                  className={`flex w-full flex-col-reverse overflow-hidden rounded-t-md transition-all ${active ? "opacity-100" : "opacity-70 group-hover:opacity-100"}`}
                  style={{ height: `${Math.max(2, (b.total / max) * 100)}%` }}
                >
                  <div className="w-full bg-emerald-400" style={{ height: `${b.total ? (b.stable / b.total) * 100 : 0}%` }} />
                  <div className="w-full flex-1 bg-emerald-400/35" />
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-1.5 flex gap-2 px-1 text-[10px] tabular-nums text-ink-3">
          {bars.map((b) => (
            <span key={b.day} className="min-w-0 flex-1 truncate text-center">
              {dayLabel(b.day)}
            </span>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-emerald-400" /> SOL & USDC · nilai akurat
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-emerald-400/35" /> memecoin · dinilai dengan harga sekarang
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-3">{hover != null ? dayLabel(sel.day) : "Hari terakhir"}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-emerald-300">+{usd.format(sel.total)}</div>
        <div className="text-xs text-ink-3">
          {sel.claims} transaksi claim · {usd.format(sel.stable)} dalam SOL/USDC
        </div>
        <ul className="mt-3 space-y-1.5 text-xs tabular-nums">
          {sel.priced.slice(0, 6).map((t) => (
            <li key={t.mint} className="flex justify-between gap-3">
              <span className="truncate text-ink-2">
                +{fmtNum(t.amount, t.amount >= 1000 ? 0 : t.amount >= 1 ? 2 : 4)} {t.symbol}
              </span>
              <span className="text-ink-3">{t.usd == null ? "–" : usd.format(t.usd)}</span>
            </li>
          ))}
          {sel.priced.length > 6 && <li className="text-ink-3">+{sel.priced.length - 6} token lain</li>}
        </ul>
        <div className="mt-4 border-t border-white/[0.06] pt-3 text-xs text-ink-3">
          Total {bars.length} hari: <span className="font-medium text-ink">{usd.format(total)}</span>
          <br />
          {usd.format(stableTotal)} di antaranya SOL/USDC
        </div>
      </div>
    </div>
  );
}
