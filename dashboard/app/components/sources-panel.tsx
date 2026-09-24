"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL, integer } from "../lib/format";
import type { UsageItem } from "../lib/types";
import { StatusDot } from "./ui";

type FreshnessItem = { key: string; label: string; age_sec: number | null; max_age_sec: number; status: "ok" | "stale" | "off" };

/** What each source supplies, which pages lean on it, and which freshness row belongs to it. Written out because
 * a list of call counts does not tell anyone what breaks when a source goes quiet. */
const SOURCES: {
  provider: string;
  name: string;
  kind: string;
  freshness: string[];
  supplies: string[];
  pages: string;
  note?: string;
}[] = [
  {
    provider: "meteora",
    name: "Meteora",
    kind: "API data DLMM",
    freshness: ["pool_snapshots", "candles"],
    supplies: ["Daftar pool, TVL, volume, fee", "Candle harga", "Posisi LP dan riwayatnya", "Limit order"],
    pages: "Screener, Pool baru, Portofolio LP, semua uji paper",
  },
  {
    provider: "helius",
    name: "Helius",
    kind: "RPC Solana",
    freshness: ["price_ticks"],
    supplies: ["Harga langsung dari chain", "Isi tiap bin posisi", "Transaksi wallet", "Penyusunan transaksi claim, tutup posisi, limit order"],
    pages: "Portofolio LP, Wallet, Hasil bersih",
  },
  {
    provider: "rugcheck",
    name: "RugCheck",
    kind: "Keamanan token",
    freshness: ["token_security"],
    supplies: ["Mint & freeze authority", "Status LP terkunci", "Flag bahaya kontrak"],
    pages: "Screener (gerbang keamanan), Pool baru, Uji Panda",
  },
  {
    provider: "gmgn",
    name: "GMGN",
    kind: "Analisis dompet",
    freshness: ["token_insights"],
    supplies: ["Persentase insider", "Bundler", "Riwayat dev pembuat token"],
    pages: "Screener, Pool baru, Uji Panda",
  },
  {
    provider: "geckoterminal",
    name: "GeckoTerminal",
    kind: "Arus transaksi",
    freshness: ["pool_flow"],
    supplies: ["Jumlah transaksi beli vs jual", "Jumlah pembeli vs penjual"],
    pages: "Screener (tekanan jual), detail pool",
    note: "Sering kena rate limit; siklus yang gagal dilewati dan diambil lagi berikutnya.",
  },
  {
    provider: "jupiter",
    name: "Jupiter",
    kind: "Harga & rute swap",
    freshness: ["token_organic"],
    supplies: ["Organic score token", "Harga token di wallet", "Quote swap untuk jual dan Tutup + jual"],
    pages: "Wallet, Portofolio LP, Hasil bersih",
  },
  {
    provider: "pump.fun",
    name: "pump.fun",
    kind: "Status peluncuran",
    freshness: ["token_pump"],
    supplies: ["Token asal pump.fun", "Status lulus bonding curve"],
    pages: "Screener, Pool baru",
  },
];

const OTHERS = [
  { name: "open.er-api.com", what: "Kurs USD ke rupiah", pages: "Modal dan P/L rupiah di Portofolio" },
  { name: "Telegram Bot API", what: "Mengirim alert dan menerima perintah", pages: "Alert pool baru, gate, LP baru, data basi" },
];

function age(sec: number | null): string {
  if (sec == null) return "belum ada";
  if (sec < 90) return `${Math.round(sec)} dtk lalu`;
  if (sec < 5400) return `${Math.round(sec / 60)} mnt lalu`;
  return `${(sec / 3600).toFixed(1)} jam lalu`;
}

export default function SourcesPanel({ items }: { items: UsageItem[] | null }) {
  const [fresh, setFresh] = useState<FreshnessItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${ENGINE_URL}/api/freshness`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { items: FreshnessItem[] } | null) => !cancelled && b && setFresh(b.items))
        .catch(() => undefined);
    void load();
    // Poll only while the tab is visible, and fetch straight away when it is opened again.
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  const calls = (provider: string, kind: UsageItem["kind"]) =>
    (items ?? []).filter((i) => i.provider === provider && i.kind === kind).reduce((n, i) => n + i.last_24h, 0);

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="border-b border-line bg-white/[0.02] px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Dari mana datanya</h2>
        <p className="mt-0.5 text-xs text-ink-3">Tujuh sumber, masing-masing dengan tugasnya sendiri. Kalau satu diam, yang berhenti hanya bagian itu.</p>
      </div>
      <ul className="divide-y divide-line">
        {SOURCES.map((s) => {
          const ok = calls(s.provider, "http");
          const err = calls(s.provider, "http_error");
          const rows = fresh.filter((f) => s.freshness.includes(f.key));
          const stale = rows.some((f) => f.status !== "ok");
          return (
            <li key={s.provider} className="grid gap-x-5 gap-y-2 px-4 py-3.5 lg:grid-cols-[13rem_1fr_11rem]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusDot severity={stale ? "warning" : "good"} />
                  <span className="truncate text-[15px] font-semibold text-ink">{s.name}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-ink-3">{s.kind}</div>
                <div className="mt-1 text-[11px] tabular-nums text-ink-3">
                  {integer.format(ok)} panggilan / 24 jam
                  {err > 0 && <span className="text-amber-300/90"> · {integer.format(err)} error</span>}
                </div>
              </div>
              <div className="min-w-0 text-xs text-ink-2">
                <ul className="space-y-0.5">
                  {s.supplies.map((x) => (
                    <li key={x} className="truncate">
                      · {x}
                    </li>
                  ))}
                </ul>
                <div className="mt-1 truncate text-[11px] text-ink-3">Dipakai di: {s.pages}</div>
                {s.note && <div className="mt-0.5 text-[11px] text-amber-300/80">{s.note}</div>}
              </div>
              <div className="text-xs lg:text-right">
                {rows.length === 0 ? (
                  <span className="text-ink-3">–</span>
                ) : (
                  rows.map((f) => (
                    <div key={f.key} className="tabular-nums">
                      <span className={f.status === "ok" ? "text-ink-2" : "text-amber-300"}>{age(f.age_sec)}</span>
                      <div className="text-[11px] text-ink-3">{f.label.replace(/\s*\(.*\)$/, "")}</div>
                    </div>
                  ))
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line bg-raised/10 px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Tidak terhitung di tabel panggilan</div>
        <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
          {OTHERS.map((o) => (
            <li key={o.name}>
              <span className="font-medium text-ink">{o.name}</span> — {o.what}. <span className="text-ink-3">{o.pages}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
