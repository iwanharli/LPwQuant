"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../lib/auto-refresh";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../lib/format";
import PageHeader from "./page-header";
import { SkeletonStrip, SkeletonTable } from "./skeleton";
import TopBar from "./top-bar";

type Event = { pool: string; name: string; kind: "drained" | "suspicious"; at: number; evidence: Record<string, unknown> };
type Wallet = { wallet: string; drained: number; suspicious: number; drained_usd: number; last_at: number | null; events: Event[] };
type Report = { wallets: Wallet[]; watched_pools: number; rules: { watch_hours: number; min_peak_tvl: number; drain_pct: number } };

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

function EventLine({ e }: { e: Event }) {
  const ev = e.evidence as { peak_tvl?: number; tvl_after?: number; hours_after_seen?: number; signs?: string[] };
  return (
    <li className="grid gap-1 px-4 py-2.5 text-sm md:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/pool/${e.pool}`} className="font-medium text-ink hover:text-accent">
            {e.name.replace("-", "/")}
          </Link>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              e.kind === "drained" ? "bg-rose-500/15 text-rose-300" : "bg-amber-400/10 text-amber-300"
            }`}
          >
            {e.kind === "drained" ? "Likuiditas dikuras" : "Pool sangat mencurigakan"}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-ink-3">
          {e.kind === "drained"
            ? `TVL ${usd.format(ev.peak_tvl ?? 0)} → ${usd.format(ev.tvl_after ?? 0)}${
                ev.hours_after_seen != null ? ` · ${fmtNum(ev.hours_after_seen, 1)} jam setelah pool terlihat` : ""
              }`
            : (ev.signs ?? []).join(" · ")}
        </div>
      </div>
      <div className="text-xs text-ink-3 md:text-right">{fmtDateTime(e.at)}</div>
    </li>
  );
}

export default function DangerPage() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch(`${ENGINE_URL}/api/danger-wallets`)
      .then((x) => (x.ok ? x.json() : Promise.reject(x.status)))
      .then((b: Report) => {
        setR(b);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  useAutoRefresh(load, 60_000);
  useEffect(load, [load]);

  const drainedTotal = r?.wallets.reduce((n, w) => n + w.drained_usd, 0) ?? 0;
  const repeat = r?.wallets.filter((w) => w.drained + w.suspicious >= 2).length ?? 0;

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader title="Wallet" accent="berbahaya" subtitle="Pembuat pool yang menguras pool-nya setelah peluncuran, atau membuat pool sangat mencurigakan." />

        {!r && !error && (
          <>
            <SkeletonStrip count={4} />
            <SkeletonTable rows={6} columns={5} />
          </>
        )}
        {!r && error && <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>}

        {r && (
          <>
            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
              <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
                <Kpi label="Wallet tercatat" value={String(r.wallets.length)} cls={r.wallets.length ? "text-rose-300" : undefined} hint="pembuat pool berbahaya" />
                <Kpi label="Pelaku berulang" value={String(repeat)} cls={repeat ? "text-rose-300" : undefined} hint="2 kejadian atau lebih" />
                <Kpi label="Likuiditas dikuras" value={usd.format(drainedTotal)} hint="total TVL yang hilang dari pool mereka" />
                <Kpi label="Pool dipantau" value={String(r.watched_pools)} hint={`pool baru, selama ${r.rules.watch_hours} jam pertama`} />
              </div>
            </section>

            <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3 text-sm leading-6 text-ink-3">
              Setiap pool baru dipantau {r.rules.watch_hours} jam pertama. Pembuatnya (dibaca dari akun pool on-chain) masuk daftar bila TVL pool
              pernah ≥ {usd.format(r.rules.min_peak_tvl)} lalu turun di bawah {r.rules.drain_pct}% dari puncaknya, atau bila pool-nya punya 2+ tanda
              sangat mencurigakan. Pool baru dari wallet di daftar ini otomatis diberi tanda bahaya di screener. Catatan: yang tercatat adalah pembuat
              pool; kalau likuiditasnya milik orang lain, pembuat belum tentu yang menariknya.
            </p>

            {r.wallets.length === 0 ? (
              <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center text-sm text-ink-3">
                Belum ada wallet yang tercatat. Pemantauan berjalan tiap 5 menit.
              </p>
            ) : (
              <div className="space-y-3">
                {r.wallets.map((w, i) => {
                  const isOpen = open === w.wallet;
                  return (
                    <section key={w.wallet} className="overflow-hidden rounded-2xl border border-rose-500/20 bg-panel">
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen ? null : w.wallet)}
                        aria-expanded={isOpen}
                        className="grid w-full grid-cols-2 items-center gap-x-5 gap-y-2 px-4 py-3.5 text-left hover:bg-white/[0.02] md:grid-cols-[auto_1.4fr_1fr_1fr_1fr_auto]"
                      >
                        <span className="grid h-9 w-9 place-items-center rounded-full bg-rose-500/15 text-sm font-bold text-rose-300">{i + 1}</span>
                        <span>
                          <span className="font-mono font-semibold text-ink">{short(w.wallet)}</span>
                          <span className="block text-[11px] text-ink-3">{w.last_at ? `terakhir ${fmtDateTime(w.last_at)}` : ""}</span>
                        </span>
                        <span>
                          <span className="block text-[11px] uppercase tracking-[0.08em] text-ink-3">Dikuras</span>
                          <span className={`font-semibold ${w.drained ? "text-rose-300" : "text-ink-3"}`}>{w.drained}× pool</span>
                        </span>
                        <span>
                          <span className="block text-[11px] uppercase tracking-[0.08em] text-ink-3">Mencurigakan</span>
                          <span className={`font-semibold ${w.suspicious ? "text-amber-300" : "text-ink-3"}`}>{w.suspicious}× pool</span>
                        </span>
                        <span>
                          <span className="block text-[11px] uppercase tracking-[0.08em] text-ink-3">TVL hilang</span>
                          <span className="font-semibold tabular-nums text-ink">{usd.format(w.drained_usd)}</span>
                        </span>
                        <span className="flex items-center gap-3 text-xs">
                          <a
                            href={`https://solscan.io/account/${w.wallet}`}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-ink-3 hover:text-accent"
                          >
                            Solscan ↗
                          </a>
                          <span className="text-ink-3">{isOpen ? "▾" : "▸"}</span>
                        </span>
                      </button>
                      {isOpen && (
                        <ul className="divide-y divide-white/[0.05] border-t border-line">
                          {w.events.map((e) => (
                            <EventLine key={`${e.pool}-${e.kind}`} e={e} />
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
