"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINE_URL, fmtNum, fmtSignedPct, usdCompact } from "../lib/format";
import { flagMeta } from "../lib/flags";
import DangerBanner from "./danger-banner";
import PumpWarning from "./pump-warning";
import TopBar from "./top-bar";
import PageHeader from "./page-header";
import { StatusDot } from "./ui";
import { SkeletonTable } from "./skeleton";

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

type Filter = "all" | "ok" | "pending" | "blocked";
type TokenFilter = "all" | "new" | "old";

const TOKEN_KIND = {
  new: { label: "Token baru", cls: "border-accent/45 bg-accent/10 text-accent", hint: "Token diluncurkan kurang dari 24 jam lalu" },
  old: { label: "Token lama", cls: "border-sky-400/35 bg-sky-400/10 text-sky-300", hint: "Token sudah lama ada; ini pool tambahan untuknya" },
};

const VERDICT = {
  ok: { label: "Lolos cek", severity: "good" as const, cls: "border-good/35 bg-good/10 text-good" },
  pending: { label: "Menunggu RugCheck", severity: "info" as const, cls: "border-line bg-raised/60 text-ink-2" },
  blocked: { label: "Tidak lolos", severity: "critical" as const, cls: "border-critical/40 bg-critical/10 text-critical" },
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
  const pools = (data?.pools ?? []).filter((p) => tokenFilter === "all" || p.token_kind === tokenFilter);
  const byToken = { all: data?.pools.length ?? 0, new: 0, old: 0 };
  for (const p of data?.pools ?? []) if (p.token_kind) byToken[p.token_kind] += 1;
  const counts = { all: pools.length, ok: 0, pending: 0, blocked: 0 };
  for (const p of pools) counts[p.verdict] += 1;
  const shown = filter === "all" ? pools : pools.filter((p) => p.verdict === filter);

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
        </div>

        <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel shadow-[0_14px_42px_rgba(0,0,0,0.20)] backdrop-blur-sm">
          {!data ? (
            error ? <p className="px-4 py-10 text-sm text-ink-3">Gagal memuat.</p> : <SkeletonTable rows={6} columns={5} title={false} />
          ) : shown.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <div className="text-sm font-medium text-ink">Belum ada pool baru yang cocok</div>
              <p className="mt-1 text-xs text-ink-3">
                Pool muncul di sini sekitar 1 menit setelah dibuat di Meteora. Halaman ini memeriksa ulang tiap {REFRESH_MS / 1000} detik.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {shown.map((p) => {
                const v = VERDICT[p.verdict];
                return (
                  <li key={p.address} className="grid gap-x-5 gap-y-2 px-4 py-3.5 transition-colors hover:bg-white/[0.02] lg:grid-cols-[1.5fr_0.8fr_0.8fr_0.8fr_0.9fr_1.6fr_auto] lg:items-center">
                    <div className="min-w-0">
                      <Link href={`/pool/${p.address}`} className="block truncate text-[15px] font-semibold text-ink hover:text-accent">
                        {p.name.replace("-", "/")}
                      </Link>
                      <div className="mt-0.5 empty:hidden">
                        <PumpWarning changePct1h={p.change_pct_1h} compact />
                        <DangerBanner signs={p.danger} compact />
                      </div>
                      {p.token_kind && (
                        <span
                          title={TOKEN_KIND[p.token_kind].hint}
                          className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TOKEN_KIND[p.token_kind].cls}`}
                        >
                          {TOKEN_KIND[p.token_kind].label}
                          {p.token_age_hours != null && <span className="ml-1 font-normal opacity-80">· {ageText(p.token_age_hours)}</span>}
                        </span>
                      )}
                      <div className="text-[11px] tabular-nums text-ink-3">
                        pool dibuat {ageText(p.pool_age_hours)} · {p.bin_step}bps{p.base_fee_pct != null ? ` · fee ${fmtNum(p.base_fee_pct, 2)}%` : ""}
                      </div>
                    </div>
                    <Metric label="TVL" value={usdCompact.format(p.tvl)} />
                    <Metric label="Volume" value={usdCompact.format(p.volume_24h)} />
                    <Metric
                      label="1 jam"
                      value={p.change_pct_1h == null ? "–" : fmtSignedPct(p.change_pct_1h, 1)}
                      cls={p.change_pct_1h == null ? "text-ink-3" : p.change_pct_1h >= 0 ? "text-up" : "text-down"}
                    />
                    <Metric
                      label="Top 10 holder"
                      value={p.top10_pct == null ? "–" : `${fmtNum(p.top10_pct, 0)}%`}
                      cls={p.top10_pct != null && p.top10_pct > 50 ? "text-down" : "text-ink"}
                    />
                    <div className="min-w-0">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${v.cls}`}>
                        <StatusDot severity={v.severity} />
                        {v.label}
                      </span>
                      {p.verdict !== "ok" && p.reason && <div className="mt-1 truncate text-[11px] text-ink-3">{reasonText(p)}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/pool/${p.address}`}
                        className="rounded-xl border border-white/[0.08] px-3 py-1.5 text-xs font-medium text-ink-2 hover:border-line-strong hover:text-ink"
                      >
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
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="text-xs leading-5 text-ink-3">
          &quot;Lolos cek&quot; memakai syarat yang sama dengan alert Telegram: data RugCheck sudah ada, tanpa flag bahaya, bukan dev
          serial atau bundler berat, 10 holder teratas ≤ 50%, TVL ≥ $5,000. Pool berumur menit tetap berisiko tinggi:
          belum ada data harga untuk menilai volatilitas.
        </p>
      </main>
    </div>
  );
}

function Metric({ label, value, cls = "text-ink" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="tabular-nums">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`text-sm font-medium ${cls}`}>{value}</div>
    </div>
  );
}
