"use client";

import { AreaSeries, ColorType, LineSeries, createChart, type Time, type UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ENGINE_URL, fmtDateTime, usd } from "../../lib/format";
import { useConnectedWallet, useWalletParam } from "../../lib/wallet";
import TopBar from "../top-bar";
import WalletButton from "../wallet-button";
import PortfolioHeader from "./portfolio-header";
import PortfolioTabs from "./portfolio-tabs";

const REFRESH_MS = 60_000;
const WIB_OFFSET_S = 7 * 3600; // the chart axis is UTC; shift so its labels read as WIB

import ActivityFeed, { type Activity } from "./activity-feed";
import ClaimsChart from "./claims-chart";

type NetPoint = { ts: number; wallet_usd: number; lp_usd: number; orders_usd: number; total_usd: number };

const KIND: Record<string, { label: string; dot: string }> = {
  claim: { label: "Claim fee", dot: "bg-good" },
  add_liquidity: { label: "Tambah likuiditas", dot: "bg-accent" },
  remove_liquidity: { label: "Tarik likuiditas", dot: "bg-warning" },
  limit_order_place: { label: "Pasang limit order", dot: "bg-[#8b6cf6]" },
  limit_order_cancel: { label: "Batal/tarik order", dot: "bg-[#8b6cf6]" },
  swap: { label: "Swap", dot: "bg-[#3ec6e0]" },
  rebalance: { label: "Rebalance", dot: "bg-teal-300" },
  deposit: { label: "Setoran", dot: "bg-sky-300" },
  withdraw: { label: "Penarikan", dot: "bg-orange-300" },
  gacha: { label: "Gacha", dot: "bg-fuchsia-300" },
  transfer: { label: "Transfer", dot: "bg-ink-3" },
  other: { label: "Lainnya", dot: "bg-ink-3" },
};
const FILTERS = ["all", "claim", "swap", "add_liquidity", "remove_liquidity", "rebalance", "deposit", "gacha", "limit_order_place", "limit_order_cancel", "transfer"];

function usePolled<T>(url: string | null): T | null {
  const [data, setData] = useState<{ url: string; value: T } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(url);
        if (res.ok && !cancelled) setData({ url, value: (await res.json()) as T });
      } catch {
        // keep the last good data; the next poll retries
      }
    };
    void load();
    // Poll only while the tab is visible, and fetch straight away when it is opened again.
    const timer = setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [url]);
  return data && data.url === url ? data.value : null;
}

const PAGE = 50;

/**
 * The history page by page as the reader scrolls (a sentinel row under the table asks for the next page), plus a
 * poll of the newest page so fresh transactions appear on top without a reload.
 */
function useActivityFeed(wallet: string | undefined, kind: string) {
  const [state, setState] = useState<{ key: string; items: Activity[]; hasMore: boolean; loading: boolean; error: boolean }>({
    key: "",
    items: [],
    hasMore: true,
    loading: false,
    error: false,
  });
  const key = `${wallet}|${kind}`;
  const base = wallet ? `${ENGINE_URL}/api/portfolio/activity?wallet=${wallet}&limit=${PAGE}${kind === "all" ? "" : `&kind=${kind}`}` : null;
  const busy = useRef(false);

  const loadMore = useCallback(async () => {
    if (!base || busy.current) return;
    const current = state.key === key ? state : { key, items: [], hasMore: true, loading: false, error: false };
    if (!current.hasMore) return;
    busy.current = true;
    setState({ ...current, loading: true });
    const last = current.items[current.items.length - 1];
    const url = last ? `${base}&before_ts=${last.ts}&before_sig=${last.signature}` : base;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { items: Activity[]; has_more: boolean };
      setState((prev) => {
        const items = prev.key === key ? prev.items : [];
        const seen = new Set(items.map((a) => a.signature));
        return { key, items: [...items, ...body.items.filter((a) => !seen.has(a.signature))], hasMore: body.has_more, loading: false, error: false };
      });
    } catch {
      setState((prev) => ({ ...(prev.key === key ? prev : current), loading: false, error: true }));
    } finally {
      busy.current = false;
    }
  }, [base, key, state]);

  // Newest page every minute: prepend what is new, and refresh rows the chain sync has since filled in.
  useEffect(() => {
    if (!base) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(base);
        if (!res.ok) return;
        const fresh = ((await res.json()) as { items: Activity[] }).items;
        setState((prev) => {
          if (prev.key !== key) return prev;
          const bySig = new Map(fresh.map((a) => [a.signature, a]));
          const kept = prev.items.map((a) => bySig.get(a.signature) ?? a);
          const known = new Set(prev.items.map((a) => a.signature));
          return { ...prev, items: [...fresh.filter((a) => !known.has(a.signature)), ...kept] };
        });
      } catch {
        // the next minute tries again
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [base, key]);

  const current = state.key === key ? state : { key, items: [], hasMore: true, loading: false, error: false };
  return { ...current, loadMore };
}

/** Calls `onVisible` whenever the element scrolls into view (with some margin, so the next page is ready early). */
function Sentinel({ onVisible, active }: { onVisible: () => void; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && onVisible(), { rootMargin: "400px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [onVisible, active]);
  return <div ref={ref} className="h-px" aria-hidden />;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Total worth over time, with LP and wallet coins as thin lines under it: where the money sits, not only how much. */
function NetWorthChart({ points }: { points: NetPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || points.length < 2) return;
    const accent = cssVar("--color-accent", "#c7f284");
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: cssVar("--color-ink-3", "#7d8594"), fontFamily: "inherit", fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(38,45,56,0.6)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    });
    const byTime = (pick: (p: NetPoint) => number) => {
      const m = new Map<number, number>();
      for (const p of points) m.set(Math.floor(p.ts / 1000) + WIB_OFFSET_S, pick(p));
      return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, value]) => ({ time: t as UTCTimestamp as Time, value }));
    };
    chart
      .addSeries(AreaSeries, { lineColor: accent, topColor: `${accent}33`, bottomColor: `${accent}00`, lineWidth: 2, priceLineVisible: false, title: "Total" })
      .setData(byTime((p) => p.total_usd));
    chart.addSeries(LineSeries, { color: "#8b6cf6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "LP" }).setData(byTime((p) => p.lp_usd));
    chart.addSeries(LineSeries, { color: "#3ec6e0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "Wallet" }).setData(byTime((p) => p.wallet_usd));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  return <div ref={ref} className="h-64 w-full" role="img" aria-label="Kekayaan total dari waktu ke waktu" />;
}

export default function HistoryPage() {
  const connected = useConnectedWallet();
  useWalletParam(connected);
  const [kind, setKind] = useState("all");
  const [showNoise, setShowNoise] = useState(false);
  const wallet = connected?.address;
  const net = usePolled<{ series: NetPoint[] }>(wallet ? `${ENGINE_URL}/api/portfolio/networth?wallet=${wallet}&days=30` : null);
  const activity = useActivityFeed(wallet, kind);
  const series = net?.series ?? [];
  const last = series[series.length - 1];
  const first = series[0];

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PortfolioHeader
          subtitle="Kekayaan dan transaksi wallet."/>

        <PortfolioTabs />

        {!connected ? (
          <div className="grid place-items-center rounded-2xl border border-white/[0.06] bg-panel px-6 py-16 text-center">
            <div className="text-lg font-semibold text-ink">Hubungkan wallet untuk melihat riwayat</div>
            <div className="mt-5">
              <WalletButton />
            </div>
          </div>
        ) : (
          <>
            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">Kekayaan total</h2>
                {last && (
                  <span className="flex flex-wrap items-center gap-4 text-xs tabular-nums">
                    <span className="text-sm font-semibold text-ink">{usd.format(last.total_usd)}</span>
                    {first && first !== last && (
                      <span className={last.total_usd >= first.total_usd ? "text-up" : "text-down"}>
                        {last.total_usd >= first.total_usd ? "+" : "−"}
                        {usd.format(Math.abs(last.total_usd - first.total_usd))} sejak {fmtDateTime(first.ts)}
                      </span>
                    )}
                    <span className="flex items-center gap-1.5 text-ink-3">
                      <span className="h-0.5 w-3 rounded bg-[#8b6cf6]" /> LP {usd.format(last.lp_usd)}
                    </span>
                    <span className="flex items-center gap-1.5 text-ink-3">
                      <span className="h-0.5 w-3 rounded bg-[#3ec6e0]" /> Wallet {usd.format(last.wallet_usd)}
                    </span>
                    <span className="text-ink-3">Limit order {usd.format(last.orders_usd)}</span>
                  </span>
                )}
              </div>
              <div className="px-2 py-3 sm:px-4">
                {series.length >= 2 ? (
                  <NetWorthChart points={series} />
                ) : (
                  <p className="px-2 py-8 text-sm text-ink-3">
                    {net ? "Grafik muncul setelah dua snapshot (sekitar 15 menit setelah wallet mulai dipantau)." : "Memuat…"}
                  </p>
                )}
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">Fee di-claim per hari</h2>
                <span className="text-xs text-ink-3">Dari riwayat transaksi · fee yang ikut keluar saat posisi ditutup tidak termasuk</span>
              </div>
              <div className="px-4 py-4">
                <ClaimsChart wallet={connected.address} />
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white/[0.02] px-4 py-3">
                <h2 className="mr-2 text-sm font-semibold text-ink">Aktivitas</h2>
                {FILTERS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      kind === k ? "border-accent/70 bg-accent/10 text-ink" : "border-line bg-bg/40 text-ink-2 hover:text-ink"
                    }`}
                  >
                    {k === "all" ? "Semua" : KIND[k].label}
                  </button>
                ))}
                <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-ink-3">
                  <input
                    type="checkbox"
                    checked={showNoise}
                    onChange={(e) => setShowNoise(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                  />
                  Tampilkan transfer kecil & lainnya
                </label>
              </div>
              {activity.items.length === 0 && (activity.loading || activity.hasMore) && !activity.error ? (
                <>
                  <p className="px-4 py-8 text-sm text-ink-3">Memuat…</p>
                  <Sentinel onVisible={() => void activity.loadMore()} active />
                </>
              ) : activity.items.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-ink-3">Belum ada aktivitas tercatat. Sinkronisasi pertama dari chain berjalan beberapa menit.</p>
              ) : (
                <div className="px-3 pb-2 pt-3 sm:px-4">
                  <ActivityFeed items={activity.items} showNoise={showNoise} />
                  <Sentinel onVisible={() => void activity.loadMore()} active={activity.hasMore && !activity.loading && !activity.error} />
                  <div className="px-4 py-3 text-center text-xs text-ink-3">
                    {activity.loading ? (
                      "Memuat transaksi lebih lama…"
                    ) : activity.error ? (
                      <button type="button" onClick={() => void activity.loadMore()} className="text-accent hover:underline">
                        Gagal memuat. Coba lagi
                      </button>
                    ) : activity.hasMore ? (
                      "Gulir untuk memuat lebih banyak"
                    ) : (
                      `Semua ${activity.items.length} transaksi sudah ditampilkan`
                    )}
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
