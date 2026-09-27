"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINE_URL, fmtNum, fmtSignedPct, usdCompact } from "../lib/format";
import { flagMeta } from "../lib/flags";
import DangerBanner from "./danger-banner";
import PumpWarning from "./pump-warning";
import TopBar from "./top-bar";
import { SkeletonBox, SkeletonStrip } from "./skeleton";
import PageHeader from "./page-header";
import { StatusDot } from "./ui";

const REFRESH_MS = 10_000;
const MAX_AGE_HOURS = 1;
const MIN_TVL = 500;

type NewPool = {
  address: string;
  name: string;
  base_symbol: string | null;
  bin_step: number;
  base_fee_pct: number | null;
  tvl: number;
  volume_24h: number;
  fees_24h: number;
  change_pct_1h: number | null;
  market_cap: number | null;
  holders: number | null;
  top10_pct: number | null;
  flags: string[];
  danger?: string[];
  pool_age_hours: number;
  token_age_hours: number | null;
  token_kind: "new" | "old" | null;
  verdict: "ok" | "pending" | "blocked";
  reason: string;
};

type Sort = "new" | "tvl" | "volume" | "fee";
type Filter = "all" | "ok" | "pending" | "blocked";
type TokenFilter = "all" | "new" | "old";

const TOKEN_KIND = {
  new: { label: "Token baru", cls: "border-accent/45 bg-accent/10 text-accent", hint: "Token diluncurkan kurang dari 24 jam lalu" },
  old: { label: "Token lama", cls: "border-sky-400/35 bg-sky-400/10 text-sky-300", hint: "Token sudah lama ada; ini pool tambahan untuknya" },
};

const VERDICT = {
  ok: { label: "Lolos cek", severity: "good" as const, cls: "border-good/35 bg-good/10 text-good", card: "border-good/25", bar: "bg-good" },
  pending: { label: "Menunggu RugCheck", severity: "info" as const, cls: "border-line bg-raised/60 text-ink-2", card: "border-white/[0.07]", bar: "bg-ink-3/60" },
  blocked: { label: "Tidak lolos", severity: "critical" as const, cls: "border-critical/40 bg-critical/10 text-critical", card: "border-critical/25", bar: "bg-critical" },
};

function useNewPools() {
  const [data, setData] = useState<{ pools: NewPool[]; fetchedAt: number } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/new-pools?max_age_hours=${MAX_AGE_HOURS}&min_tvl=${MIN_TVL}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { pools: NewPool[] };
        if (!cancelled) {
          setData({ pools: body.pools, fetchedAt: Date.now() });
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
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
  }, []);
  return { data, error };
}

/** Readable reason: flag keys become their labels ("flag serial_dev" → "Dev serial"). */
function reasonText(p: NewPool): string {
  if (p.reason.startsWith("flag ")) {
    return p.reason
      .slice(5)
      .split(", ")
      .map((f) => flagMeta(f).label)
      .join(" · ");
  }
  return p.reason;
}

const SORT: Record<Sort, { label: string; key: (p: NewPool) => number }> = {
  new: { label: "Terbaru", key: (p) => -p.pool_age_hours },
  tvl: { label: "TVL", key: (p) => p.tvl },
  volume: { label: "Volume", key: (p) => p.volume_24h },
  fee: { label: "Fee/TVL", key: (p) => (p.tvl > 0 ? p.fees_24h / p.tvl : 0) },
};
const FRESH_MIN = 10;

const ageText = (hours: number) => {
  const m = Math.max(0, Math.round(hours * 60));
  if (m < 1) return "baru saja";
  if (m < 60) return `${m} mnt lalu`;
  if (hours < 48) return `${Math.round(hours)} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
};

export default function NewPoolsPage() {
  const { data, error } = useNewPools();
  const [filter, setFilter] = useState<Filter>("all");
  const [tokenFilter, setTokenFilter] = useState<TokenFilter>("all");
  const [sort, setSort] = useState<Sort>("new");
  const all = data?.pools ?? [];
  const pools = all.filter((p) => tokenFilter === "all" || p.token_kind === tokenFilter);
  const byToken = { all: all.length, new: 0, old: 0 };
  for (const p of all) if (p.token_kind) byToken[p.token_kind] += 1;
  const counts = { all: pools.length, ok: 0, pending: 0, blocked: 0 };
  for (const p of pools) counts[p.verdict] += 1;
  const shown = (filter === "all" ? pools : pools.filter((p) => p.verdict === filter)).sort((x, y) => SORT[sort].key(y) - SORT[sort].key(x));
  const danger = all.filter((p) => (p.danger?.length ?? 0) >= 2).length;
  const fresh = all.filter((p) => p.pool_age_hours * 60 < FRESH_MIN).length;
  const tvl = all.reduce((s, p) => s + p.tvl, 0);

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader
          title="Pool" accent="baru"
          subtitle={`Pool DLMM di bawah ${MAX_AGE_HOURS} jam dengan TVL ≥ $${MIN_TVL}, dicek keamanannya otomatis.`}
          right={
            <span className="flex items-center gap-2 text-xs text-ink-3">
              <StatusDot severity={error ? "critical" : "good"} pulse={!error} />
              {error ? "Engine tidak bisa dihubungi" : `Diperbarui tiap ${REFRESH_MS / 1000} dtk`}
            </span>
          }
        />

        {!data && !error && <SkeletonStrip count={5} />}
        {data && (
          <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
            <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-3 lg:grid-cols-5">
              <Kpi label="Pool baru" value={String(all.length)} hint={`${fresh} dalam ${FRESH_MIN} menit terakhir`} />
              <Kpi label="Token baru" value={String(byToken.new)} hint={`${byToken.old} pool untuk token lama`} cls={byToken.new ? "text-accent" : undefined} />
              <Kpi label="Lolos cek" value={String(all.filter((p) => p.verdict === "ok").length)} cls="text-good" hint={`${all.filter((p) => p.verdict === "pending").length} menunggu RugCheck`} />
              <Kpi label="Berbahaya" value={String(danger)} cls={danger ? "text-critical" : undefined} hint="2+ tanda sangat mencurigakan" />
              <Kpi label="Total TVL" value={usdCompact.format(tvl)} hint="semua pool di daftar" />
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-line bg-bg/40 p-0.5" role="group" aria-label="Jenis token">
            {(["all", "new", "old"] as TokenFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={tokenFilter === f}
                onClick={() => setTokenFilter(f)}
                title={f === "all" ? undefined : TOKEN_KIND[f].hint}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  tokenFilter === f ? "bg-white/[0.08] text-ink" : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {f === "all" ? "Semua token" : TOKEN_KIND[f].label}
                <span className="ml-1.5 tabular-nums text-ink-3">{byToken[f]}</span>
              </button>
            ))}
          </div>
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          {(["all", "ok", "pending", "blocked"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f ? "border-accent/70 bg-accent/10 text-ink" : "border-line bg-bg/40 text-ink-2 hover:text-ink"
              }`}
            >
              {f !== "all" && <StatusDot severity={VERDICT[f].severity} />}
              {f === "all" ? "Semua" : VERDICT[f].label}
              <span className="tabular-nums text-ink-3">{counts[f]}</span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5 text-xs text-ink-3" role="group" aria-label="Urutkan">
            Urutkan
            <div className="flex rounded-full border border-line bg-bg/40 p-0.5">
              {(Object.keys(SORT) as Sort[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={sort === k}
                  onClick={() => setSort(k)}
                  className={`rounded-full px-2.5 py-1 font-medium ${sort === k ? "bg-white/[0.08] text-ink" : "text-ink-3 hover:text-ink-2"}`}
                >
                  {SORT[k].label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!data ? (
          error ? (
            <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-sm text-ink-3">Gagal memuat.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <SkeletonBox key={i} className="h-56 rounded-2xl" />
              ))}
            </div>
          )
        ) : shown.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-14 text-center">
            <div className="text-sm font-medium text-ink">Belum ada pool baru yang cocok</div>
            <p className="mt-1 text-xs text-ink-3">
              Pool muncul di sini sekitar 1 menit setelah dibuat di Meteora. Halaman ini memeriksa ulang tiap {REFRESH_MS / 1000} detik.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {shown.map((p) => (
              <PoolCard key={p.address} p={p} />
            ))}
          </div>
        )}

        <p className="text-xs leading-5 text-ink-3">
          &quot;Lolos cek&quot; memakai syarat yang sama dengan alert Telegram: data RugCheck sudah ada, tanpa flag bahaya, bukan dev
          serial atau bundler berat, 10 holder teratas ≤ 50%, TVL ≥ $5,000. Pool berumur menit tetap berisiko tinggi:
          belum ada data harga untuk menilai volatilitas.
        </p>
      </main>
    </div>
  );
}

function PoolCard({ p }: { p: NewPool }) {
  const v = VERDICT[p.verdict];
  const isDanger = (p.danger?.length ?? 0) >= 2;
  const ageMin = p.pool_age_hours * 60;
  const isFresh = ageMin < FRESH_MIN;
  const feeTvl = p.tvl > 0 ? (p.fees_24h / p.tvl) * 100 : null;
  return (
    <article
      className={`relative flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-panel shadow-[0_12px_32px_rgba(0,0,0,0.18)] transition-colors hover:border-line-strong ${
        isDanger ? "border-critical/40" : v.card
      }`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${isDanger ? "bg-critical" : v.bar}`} aria-hidden />
      <div className="flex items-start justify-between gap-3 px-4 pb-2 pl-5 pt-3.5">
        <div className="min-w-0">
          <Link href={`/pool/${p.address}`} className="block truncate text-base font-semibold text-ink hover:text-accent">
            {p.name.replace("-", "/")}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {p.token_kind && (
              <span title={TOKEN_KIND[p.token_kind].hint} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TOKEN_KIND[p.token_kind].cls}`}>
                {TOKEN_KIND[p.token_kind].label}
                {p.token_age_hours != null && <span className="ml-1 font-normal opacity-80">· {ageText(p.token_age_hours)}</span>}
              </span>
            )}
            <span className="rounded-full border border-line px-2 py-0.5 text-[11px] tabular-nums text-ink-3">
              {p.bin_step} bps{p.base_fee_pct != null ? ` · fee ${fmtNum(p.base_fee_pct, 2)}%` : ""}
            </span>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums ${
            isFresh ? "live-breath border-accent/50 bg-accent/10 text-accent" : "border-line text-ink-2"
          }`}
          title="Umur pool"
        >
          {isFresh ? "● " : ""}
          {ageText(p.pool_age_hours)}
        </span>
      </div>

      <div className="px-4 pl-5 empty:hidden">
        <PumpWarning changePct1h={p.change_pct_1h} compact />
        <DangerBanner signs={p.danger} compact />
      </div>

      <div className="mx-4 ml-5 mt-2 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-white/[0.05] bg-line/30">
        <Metric label="TVL" value={usdCompact.format(p.tvl)} />
        <Metric label="Volume" value={usdCompact.format(p.volume_24h)} />
        <Metric label="Fee/TVL" value={feeTvl == null ? "–" : `${fmtNum(feeTvl, 1)}%`} cls={feeTvl != null && feeTvl >= 20 ? "text-up" : "text-ink"} />
        <Metric
          label="1 jam"
          value={p.change_pct_1h == null ? "–" : fmtSignedPct(p.change_pct_1h, 1)}
          cls={p.change_pct_1h == null ? "text-ink-3" : p.change_pct_1h >= 0 ? "text-up" : "text-down"}
        />
        <Metric label="Market cap" value={p.market_cap ? usdCompact.format(p.market_cap) : "–"} cls={p.market_cap ? "text-ink" : "text-ink-3"} />
        <Metric
          label="Top 10"
          value={p.top10_pct == null ? "–" : `${fmtNum(p.top10_pct, 0)}%`}
          cls={p.top10_pct == null ? "text-ink-3" : p.top10_pct > 50 ? "text-down" : "text-ink"}
        />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 px-4 pb-3.5 pl-5 pt-3">
        <div className="min-w-0">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${v.cls}`}>
            <StatusDot severity={v.severity} />
            {v.label}
          </span>
          {p.verdict !== "ok" && p.reason && (
            <div className="mt-1 truncate text-[11px] text-ink-3" title={reasonText(p)}>
              {reasonText(p)}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link href={`/pool/${p.address}`} className="rounded-xl border border-white/[0.08] px-3 py-1.5 text-xs font-medium text-ink-2 hover:border-line-strong hover:text-ink">
            Detail
          </Link>
          <a
            href={`https://meteora.ag/dlmm/${p.address}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-brand-meteora/45 px-3 py-1.5 text-xs font-medium text-brand-meteora hover:bg-brand-meteora/10"
          >
            Meteora ↗
          </a>
        </div>
      </div>
    </article>
  );
}

function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

function Metric({ label, value, cls = "text-ink" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="bg-panel px-3 py-2 tabular-nums">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}
