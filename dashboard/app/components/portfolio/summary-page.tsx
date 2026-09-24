"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../../lib/format";
import { useConnectedWallet, useWalletParam } from "../../lib/wallet";
import TopBar from "../top-bar";
import WalletButton from "../wallet-button";
import CapitalButtons, { type Capital } from "./capital-card";
import PortfolioHeader from "./portfolio-header";
import PortfolioTabs from "./portfolio-tabs";

type Day = { day: string; networth: number; change: number; new_money: number; lp: number; gacha: number; trading: number; partial: boolean };
type Ledger = {
  fx: { usd_idr: number };
  capital: Capital;
  networth: { usd: number; idr: number; at: number | null; wallet_usd: number | null; lp_usd: number | null; orders_usd: number | null };
  pl: { usd: number; idr: number; pct: number | null };
  breakdown: { lp: number; gacha: number; trading: number };
  fx_idr: number;
  days: Day[];
};

const rp = (v: number) => `Rp${fmtNum(Math.abs(v) / 1e6, 1)} jt`;
const signedRp = (v: number) => `${v >= 0 ? "+" : "−"}${rp(v)}`;
const signedUsd = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const tone = (v: number) => (v > 0.005 ? "text-emerald-300" : v < -0.005 ? "text-rose-300" : "text-ink-2");

function useLedger(wallet: string | undefined) {
  const [data, setData] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/portfolio/ledger?wallet=${wallet}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setData(body as Ledger);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Gagal memuat");
      }
    };
    void load();
    // Poll only while the tab is visible, and fetch straight away when it is opened again.
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [wallet, key]);
  return { data, error, reload: () => setKey((k) => k + 1) };
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const SOURCES = [
  {
    key: "lp" as const,
    label: "LP (posisi Meteora)",
    hint: "Fee dikurangi IL dari semua posisi, menurut Meteora.",
    color: "bg-emerald-400",
  },
  {
    key: "trading" as const,
    label: "Trading & token di luar LP",
    hint: "Beli-jual memecoin, token yang jatuh setelah keluar dari LP, biaya swap. Dihitung sebagai sisa.",
    color: "bg-rose-400",
  },
  {
    key: "gacha" as const,
    label: "Gacha",
    hint: "Pack yang dibayar dikurangi uang yang kembali saat kartu dijual lagi.",
    color: "bg-amber-400",
  },
];

function Breakdown({ l }: { l: Ledger }) {
  const max = Math.max(...SOURCES.map((s) => Math.abs(l.breakdown[s.key])), 1);
  const rate = l.fx.usd_idr;
  return (
    <div className="divide-y divide-white/[0.05]">
      {SOURCES.map((s) => {
        const v = l.breakdown[s.key];
        return (
          <div key={s.key} className="grid gap-2 px-4 py-4 sm:grid-cols-[1.2fr_2fr_auto] sm:items-center sm:gap-6">
            <div>
              <div className="text-sm font-medium text-ink">{s.label}</div>
              <div className="text-xs leading-5 text-ink-3">{s.hint}</div>
            </div>
            {/* Bars grow from a centre line: gains to the right, losses to the left. */}
            <div className="flex h-3 items-center">
              <div className="flex h-full w-1/2 justify-end">
                {v < 0 && <div className={`h-full rounded-l-full ${s.color} opacity-80`} style={{ width: `${(Math.abs(v) / max) * 100}%` }} />}
              </div>
              <div className="h-5 w-px bg-white/20" />
              <div className="flex h-full w-1/2">
                {v > 0 && <div className={`h-full rounded-r-full ${s.color} opacity-80`} style={{ width: `${(v / max) * 100}%` }} />}
              </div>
            </div>
            <div className="text-right tabular-nums">
              <div className={`text-lg font-semibold ${tone(v)}`}>{signedRp(v * rate)}</div>
              <div className="text-xs text-ink-3">{signedUsd(v)}</div>
            </div>
          </div>
        );
      })}
      {Math.abs(l.fx_idr) >= 50_000 && (
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[1.2fr_2fr_auto] sm:items-center sm:gap-6">
          <div>
            <div className="text-sm font-medium text-ink-2">Selisih kurs</div>
            <div className="text-xs leading-5 text-ink-3">
              {l.fx_idr > 0 ? "Rupiah melemah sejak top-up: dolar yang tersisa bernilai lebih banyak dalam rupiah." : "Rupiah menguat sejak top-up."}
            </div>
          </div>
          <div />
          <div className={`text-right text-sm font-medium tabular-nums ${tone(l.fx_idr)}`}>{signedRp(l.fx_idr)}</div>
        </div>
      )}
    </div>
  );
}

function Today({ d, rate }: { d: Day; rate: number }) {
  const outsideLp = d.trading + d.gacha;
  const bad = outsideLp < -1;
  const items = [
    { label: "LP", v: d.lp },
    { label: "Trading & token", v: d.trading },
    { label: "Gacha", v: d.gacha },
  ];
  return (
    <div className={`rounded-2xl border px-4 py-4 ${bad ? "border-rose-400/30 bg-rose-500/[0.06]" : "border-emerald-400/25 bg-emerald-500/[0.05]"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-3">Hari ini{d.partial ? " (sejak mulai dipantau)" : ""}</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone(d.change - d.new_money)}`}>
            {signedUsd(d.change - d.new_money)} <span className="text-base font-normal">({signedRp((d.change - d.new_money) * rate)})</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {items.map((i) => (
            <span key={i.label} className="rounded-full border border-white/[0.08] bg-black/20 px-3 py-1 text-xs tabular-nums">
              <span className="text-ink-3">{i.label} </span>
              <span className={`font-medium ${tone(i.v)}`}>{signedUsd(i.v)}</span>
            </span>
          ))}
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-ink-2">
        {bad
          ? `Di luar LP hari ini sudah ${signedUsd(outsideLp)}. Dari data kamu sendiri, bagian inilah yang menghabiskan modal: sebaiknya berhenti trading dan gacha dulu hari ini.`
          : "Di luar LP hari ini tidak minus. Pertahankan: biarkan modal bekerja di LP saja."}
      </p>
    </div>
  );
}

function Days({ days }: { days: Day[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm tabular-nums">
        <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
          <tr className="border-b border-line">
            <th className="px-4 py-2.5 text-left font-medium">Hari</th>
            <th className="px-3 py-2.5 text-right font-medium">LP</th>
            <th className="px-3 py-2.5 text-right font-medium">Trading & token</th>
            <th className="px-3 py-2.5 text-right font-medium">Gacha</th>
            <th className="px-3 py-2.5 text-right font-medium">Setoran</th>
            <th className="px-4 py-2.5 text-right font-medium">Kekayaan akhir hari</th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.day} className="border-b border-line/60 last:border-b-0">
              <td className="px-4 py-2.5 text-ink-2">
                {new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d.day}T00:00:00Z`))}
                {d.partial && <span className="ml-1 text-[10px] text-ink-3">(sebagian)</span>}
              </td>
              <td className={`px-3 py-2.5 text-right ${tone(d.lp)}`}>{signedUsd(d.lp)}</td>
              <td className={`px-3 py-2.5 text-right ${tone(d.trading)}`}>{signedUsd(d.trading)}</td>
              <td className={`px-3 py-2.5 text-right ${tone(d.gacha)}`}>{Math.abs(d.gacha) < 0.005 ? "–" : signedUsd(d.gacha)}</td>
              <td className="px-3 py-2.5 text-right text-ink-3">{Math.abs(d.new_money) < 0.5 ? "–" : signedUsd(d.new_money)}</td>
              <td className="px-4 py-2.5 text-right text-ink">{usd.format(d.networth)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SummaryPage() {
  const connected = useConnectedWallet();
  useWalletParam(connected);
  const { data: l, error, reload } = useLedger(connected?.address);
  const today = l?.days[l.days.length - 1];
  const manual = l?.capital.entries.filter((e) => e.source === "manual") ?? [];

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PortfolioHeader
          subtitle="Modal, kekayaan sekarang, dan dari mana untung-ruginya."
          right={
            connected && l ? (
              <CapitalButtons wallet={connected.address} capital={l.capital} rate={l.fx.usd_idr} onChange={reload} />
            ) : undefined
          }
        />
        <PortfolioTabs />

        {!connected ? (
          <div className="grid place-items-center rounded-2xl border border-white/[0.06] bg-panel px-6 py-16 text-center">
            <div className="text-lg font-semibold text-ink">Hubungkan wallet untuk melihat ringkasan</div>
            <div className="mt-5"><WalletButton /></div>
          </div>
        ) : !l ? (
          <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-sm text-ink-3">{error ?? "Menghitung…"}</p>
        ) : (
          <>
            {/* The one number that matters, in rupiah first: what went in, what is left. */}
            <section className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-[#12161d] via-[#0e1217] to-[#0b0e13] px-6 py-6">
              <div className={`pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl ${l.pl.usd >= 0 ? "bg-emerald-500/10" : "bg-rose-500/10"}`} />
              <div className="relative grid gap-6 lg:grid-cols-[1fr_auto_1fr_auto_1.2fr] lg:items-center">
                <div>
                  <div className="text-xs uppercase tracking-wider text-ink-3">Modal disetor</div>
                  <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-ink">{rp(l.capital.idr)}</div>
                  <div className="text-xs text-ink-3">
                    {manual.length ? "catatan kamu" : "terdeteksi dari top-up"} · {usd.format(l.capital.usd)} USDC masuk
                  </div>
                </div>
                <div className="hidden text-2xl text-ink-3 lg:block">→</div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-ink-3">Kekayaan sekarang</div>
                  <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-ink">{rp(l.networth.idr)}</div>
                  <div className="text-xs text-ink-3">
                    {usd.format(l.networth.usd)} · LP {usd.format(l.networth.lp_usd ?? 0)} · wallet {usd.format(l.networth.wallet_usd ?? 0)}
                  </div>
                </div>
                <div className="hidden h-14 w-px bg-white/10 lg:block" />
                <div>
                  <div className="text-xs uppercase tracking-wider text-ink-3">Untung / rugi</div>
                  <div className={`mt-1 text-4xl font-bold tabular-nums tracking-tight ${tone(l.pl.usd)}`}>{signedRp(l.pl.idr)}</div>
                  <div className={`text-sm tabular-nums ${tone(l.pl.usd)}`}>
                    {signedUsd(l.pl.usd)}
                    {l.pl.pct != null && ` · ${l.pl.pct >= 0 ? "+" : ""}${fmtNum(l.pl.pct, 1)}%`}
                  </div>
                </div>
              </div>
              <div className="relative mt-4 text-[11px] text-ink-3">
                Kurs Rp{new Intl.NumberFormat("id-ID").format(Math.round(l.fx.usd_idr))}/USD · kekayaan per {l.networth.at ? fmtDateTime(l.networth.at) : "–"} WIB
              </div>
            </section>

            {today && <Today d={today} rate={l.fx.usd_idr} />}

            <Card title="Dari mana untung-ruginya" right={<span className="text-xs text-ink-3">Sejak modal disetor</span>}>
              <Breakdown l={l} />
            </Card>

            <Card title="Per hari" right={<span className="text-xs text-ink-3">Sejak kekayaan mulai dicatat · USD</span>}>
              {l.days.length ? <Days days={l.days} /> : <p className="px-4 py-6 text-sm text-ink-3">Belum ada data harian.</p>}
            </Card>

          </>
        )}
      </main>
    </div>
  );
}
