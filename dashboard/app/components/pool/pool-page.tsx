"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { STRATEGY_LABEL } from "../../lib/flags";
import {
  ENGINE_URL,
  binAlignedRange,
  fmtDateTime,
  fmtPct,
  fmtPriceExact,
  fmtSignedPct,
  usd,
  usdCompact,
} from "../../lib/format";
import { PROFILE_COLORS } from "../../lib/paper-types";
import type {
  CandleResponse,
  PoolDetail,
  PoolPaperPosition,
  ProfileDecision,
  Timeframe,
} from "../../lib/pool-detail-types";
import { isActivePlan, type ActivePlan } from "../../lib/types";
import BusyHours from "../busy-hours";
import TopBar from "../top-bar";
import { Delta, PlanBadge, RegimeBadge, StatusDot, TokenAvatar } from "../ui";
import CandleChart, { type ChartLevel, type ChartMarker } from "./candle-chart";

const TIMEFRAMES: { key: Timeframe; label: string; seconds: number; hint: string }[] = [
  { key: "5m", label: "5m", seconds: 300, hint: "24 jam" },
  { key: "30m", label: "30m", seconds: 1800, hint: "7 hari" },
  { key: "1h", label: "1j", seconds: 3600, hint: "7 hari" },
  { key: "4h", label: "4j", seconds: 14_400, hint: "30 hari" },
];
const DETAIL_REFRESH_MS = 15_000;
const CANDLE_REFRESH_MS = 60_000;

const EXIT_LABEL: Record<string, string> = {
  stop_loss: "stop-loss",
  out_of_range: "keluar range",
  breakout: "breakout",
  fee_decay: "fee turun",
  max_hold: "batas waktu",
  delisted: "hilang dari screener",
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function usePolling<T>(path: string | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const load = async () => {
      try {
        const body = await getJson<T>(path);
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Gagal memuat");
      }
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, intervalMs]);
  return { data, error };
}

function cssColor(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium tabular-nums text-ink">{children}</div>
    </div>
  );
}

function CopyPrice({ label, value }: { label: string; value: number }) {
  const [copied, setCopied] = useState(false);
  const text = fmtPriceExact(value);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="group flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-bg/60 px-3 py-2 text-left transition-colors hover:border-line-strong"
      title="Salin untuk kolom harga di Meteora"
    >
      <span className="text-xs text-ink-3">{label}</span>
      <span className="font-mono text-sm text-ink">{copied ? "Disalin" : text}</span>
    </button>
  );
}

function RangePanel({
  plan,
  price,
  binStep,
  gated,
  feePctDay,
}: {
  plan: ActivePlan;
  price: number;
  binStep: number;
  gated: boolean;
  feePctDay: number;
}) {
  const range = binAlignedRange(price, binStep, plan.range_low_pct, plan.range_high_pct);
  // The un-gated base plan carries no gate estimate; the default gate counts 1 hour of the position's fees.
  const feeWindowPct = plan.fee_over_min_hold_pct ?? feePctDay / 24;
  return (
    <div className={gated ? "opacity-80" : ""}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{STRATEGY_LABEL[plan.strategy] ?? plan.strategy}</span>
        <span className="text-xs text-ink-3">
          {plan.range_low_pct}% / +{plan.range_high_pct}% · {range.below + range.above + 1} bin · {plan.positions} posisi
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-ink-3">{plan.note}</p>
      <div className="mt-3 space-y-2">
        <CopyPrice label="Max price" value={range.max} />
        <CopyPrice label="Harga sekarang" value={price} />
        <CopyPrice label="Min price" value={range.min} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Stat label="Ukuran">{usd.format(plan.size_usd)}</Stat>
        <Stat label="Fee / hari">{usd.format(plan.expected_fee_usd_day)}</Stat>
        <Stat label="Biaya bolak-balik">{plan.round_trip_cost_pct != null ? fmtPct(plan.round_trip_cost_pct, 2) : "–"}</Stat>
        <Stat label="Fee 1 jam (filter)">{fmtPct(feeWindowPct, 2)}</Stat>
        <Stat label="Stop-loss">−{plan.exit.stop_loss_pct}%</Stat>
        <Stat label="Keluar range">{plan.exit.out_of_range_minutes} mnt</Stat>
        <Stat label="Breakout bawah">{plan.exit.breakout_below_pct != null ? `${plan.exit.breakout_below_pct}%` : "–"}</Stat>
        <Stat label="Breakout atas">{plan.exit.breakout_above_pct != null ? `+${plan.exit.breakout_above_pct}%` : "–"}</Stat>
      </div>
    </div>
  );
}

function DecisionRow({ d }: { d: ProfileDecision }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        className="mt-2 h-0.5 w-4 shrink-0 rounded-full"
        style={{ background: PROFILE_COLORS[d.key] ?? "var(--color-accent)" }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">{d.label}</span>
          {d.holding ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
              <StatusDot severity={d.holding.in_range ? "good" : "warning"} /> Memegang ·{" "}
              {fmtSignedPct(d.holding.pnl_pct, 2)}
            </span>
          ) : d.enter ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
              <StatusDot severity="good" /> Boleh masuk
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
              <StatusDot severity="info" /> Tidak masuk
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs leading-5 text-ink-3">
          {d.enter
            ? `${usd.format(d.size_usd ?? 0)} · stop-loss −${d.stop_loss_pct ?? "–"}% · tahan min ${d.min_hold_hours ?? "–"} j`
            : d.reason}
          {d.holding && ` · masuk ${fmtDateTime(d.holding.entry_ts)} WIB, ${usd.format(d.holding.capital_usd)}`}
        </div>
      </div>
    </li>
  );
}

export default function PoolPage({ address }: { address: string }) {
  const [tf, setTf] = useState<Timeframe>("30m");
  const [logScale, setLogScale] = useState(false);
  const detail = usePolling<PoolDetail>(`/api/pools/${address}`, DETAIL_REFRESH_MS);
  const candles = usePolling<CandleResponse>(`/api/pools/${address}/candles?tf=${tf}`, CANDLE_REFRESH_MS);
  const paper = usePolling<{ positions: PoolPaperPosition[] }>(`/api/pools/${address}/paper`, CANDLE_REFRESH_MS);
  const [showProfiles, setShowProfiles] = useState<Record<string, boolean>>({});

  const pool = detail.data?.pool;
  const plan = pool?.plan;
  const active = plan && isActivePlan(plan) ? plan : null;
  const base = active ?? pool?.plan_base ?? null;
  const tfInfo = TIMEFRAMES.find((t) => t.key === tf)!;
  const tfCandles = candles.data?.tf === tf ? candles.data.candles : [];

  const levels = useMemo<ChartLevel[]>(() => {
    if (!pool || !base) return [];
    const accent = cssColor("--color-accent", "#49a4ff");
    const critical = cssColor("--color-critical", "#ef4444");
    const warning = cssColor("--color-warning", "#f5b84b");
    const range = binAlignedRange(pool.price, pool.bin_step, base.range_low_pct, base.range_high_pct);
    const out: ChartLevel[] = [
      { price: range.max, title: "Max range", color: accent, style: "dashed" },
      { price: range.min, title: "Min range", color: accent, style: "dashed" },
      { price: pool.price * (1 - base.exit.stop_loss_pct / 100), title: "Stop-loss", color: critical, style: "dotted" },
    ];
    if (base.exit.breakout_below_pct != null)
      out.push({ price: pool.price * (1 + base.exit.breakout_below_pct / 100), title: "Breakout", color: warning, style: "dotted" });
    if (base.exit.breakout_above_pct != null)
      out.push({ price: pool.price * (1 + base.exit.breakout_above_pct / 100), title: "Breakout", color: warning, style: "dotted" });
    return out;
  }, [pool, base]);

  const markers = useMemo<ChartMarker[]>(() => {
    const out: ChartMarker[] = [];
    for (const p of paper.data?.positions ?? []) {
      if (showProfiles[p.profile] === false) continue;
      const color = PROFILE_COLORS[p.profile] ?? "#49a4ff";
      const initial = p.profile.slice(0, 1).toUpperCase();
      out.push({ ts: p.entry_ts, position: "below", shape: "up", color, text: `${initial} masuk` });
      if (p.exit_ts)
        out.push({
          ts: p.exit_ts,
          position: "above",
          shape: "down",
          color,
          text: `${initial} ${EXIT_LABEL[p.exit_reason ?? ""] ?? p.exit_reason ?? "keluar"} ${fmtSignedPct(p.pnl_pct, 1)}`,
        });
    }
    return out;
  }, [paper.data, showProfiles]);

  const profileKeys = (detail.data?.profiles ?? []).map((p) => p.key);
  // How many paper positions each profile has here: a profile with none has nothing to show or hide.
  const profileCounts = new Map<string, number>();
  for (const p of paper.data?.positions ?? []) profileCounts.set(p.profile, (profileCounts.get(p.profile) ?? 0) + 1);
  const anyPaper = (paper.data?.positions ?? []).length > 0;

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="rounded-md px-2 py-1 text-sm text-ink-3 transition-colors hover:bg-raised hover:text-ink">
              ← Screener
            </Link>
            {pool && <TokenAvatar symbol={pool.base_symbol} />}
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-ink">{pool?.name ?? "Memuat pool…"}</h1>
              <div className="font-mono text-xs text-ink-3">{address}</div>
            </div>
            {plan && <PlanBadge plan={plan} size="md" />}
          </div>
          {pool && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
              <Stat label="Harga">{fmtPriceExact(pool.price)}</Stat>
              <Stat label="1 jam">
                <Delta value={pool.change_pct_1h} />
              </Stat>
              <Stat label="TVL">{usdCompact.format(pool.tvl)}</Stat>
              <Stat label="Volume 24j">{usdCompact.format(pool.volume_24h)}</Stat>
              <Stat label="Bin step">
                {pool.bin_step} · fee {pool.base_fee_pct}%
              </Stat>
            </div>
          )}
        </div>

        {detail.error && (
          <p className="flex items-center gap-2 rounded-2xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2">
            <StatusDot severity="critical" />
            {detail.error === "HTTP 404" ? "Pool ini tidak ada di screener saat ini." : `${detail.error}. Pastikan engine berjalan.`}
          </p>
        )}

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel/90 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
              <div role="tablist" aria-label="Timeframe" className="flex rounded-lg border border-line bg-bg/80 p-1 shadow-inner shadow-black/20">
                {TIMEFRAMES.map((t) => (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={tf === t.key}
                    onClick={() => setTf(t.key)}
                    title={`Candle ${t.label}, ${t.hint} terakhir`}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      tf === t.key ? "bg-raised text-ink shadow-sm shadow-black/25" : "text-ink-3 hover:bg-raised/50 hover:text-ink-2"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
                <span className="mx-1 w-px self-stretch bg-line" aria-hidden />
                <button
                  type="button"
                  aria-pressed={logScale}
                  onClick={() => setLogScale((v) => !v)}
                  title="Skala harga logaritmik: kenaikan 2x terlihat sama besar di harga berapa pun"
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    logScale ? "bg-raised text-ink shadow-sm shadow-black/25" : "text-ink-3 hover:bg-raised/50 hover:text-ink-2"
                  }`}
                >
                  Log
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
                {profileKeys.map((k) => {
                  const on = showProfiles[k] !== false;
                  const count = profileCounts.get(k) ?? 0;
                  const label = detail.data?.profiles.find((p) => p.key === k)?.label ?? k;
                  return (
                    <label
                      key={k}
                      title={
                        count
                          ? `Tampilkan ${count} posisi paper profil ${label} di grafik`
                          : `Profil ${label} belum pernah masuk di pool ini, jadi tidak ada penanda untuk disembunyikan`
                      }
                      className={`inline-flex items-center gap-1.5 ${count ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!count}
                        onChange={() => setShowProfiles((s) => ({ ...s, [k]: !on }))}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="h-0.5 w-3 rounded-full" style={{ background: PROFILE_COLORS[k] }} aria-hidden />
                      {label}
                      <span className="tabular-nums text-ink-3">{count}</span>
                    </label>
                  );
                })}
                {!anyPaper && paper.data && (
                  <span className="text-ink-3">Belum ada posisi paper di pool ini, jadi centang profil belum mengubah apa pun.</span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0 w-4 border-t border-dashed border-accent" aria-hidden /> Range
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0 w-4 border-t border-dotted border-critical" aria-hidden /> Stop-loss
                </span>
              </div>
            </div>
            <div className="relative px-2 py-2">
              <CandleChart
                candles={tfCandles}
                levels={levels}
                markers={markers}
                tfSeconds={tfInfo.seconds}
                livePrice={pool?.price ?? null}
                logScale={logScale}
              />
              {!candles.data && !candles.error && (
                <div className="absolute inset-0 grid place-items-center text-sm text-ink-3">Memuat candle…</div>
              )}
              {candles.error && (
                <div className="absolute inset-0 grid place-items-center text-sm text-ink-3">
                  Candle tidak tersedia ({candles.error}).
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-ink-3">
              <span>
                {tfCandles.length} candle {tfInfo.label} · {tfInfo.hint} terakhir · sumber{" "}
                {candles.data?.source === "db" ? "database (Meteora)" : "Meteora"} · waktu WIB
              </span>
              <span>Level range dan exit dihitung dari harga sekarang</span>
            </div>
          </section>

          <aside className="space-y-5">
            <section className="rounded-2xl border border-line bg-panel/90 p-4 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">Rekomendasi range</h2>
                {pool?.regime && <RegimeBadge regime={pool.regime} />}
              </div>
              {!pool ? (
                <p className="mt-3 text-sm text-ink-3">Memuat…</p>
              ) : base ? (
                <div className="mt-3">
                  {!active && plan && (
                    <p className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-5 text-ink-2">
                      Rencana default ditahan: {plan.reason}. Range di bawah adalah rencana dasar sebelum filter biaya;
                      profil yang aturannya lebih longgar bisa tetap masuk.
                    </p>
                  )}
                  <RangePanel
                    plan={base}
                    price={pool.price}
                    binStep={pool.bin_step}
                    gated={!active}
                    feePctDay={pool.fee_for_position_pct_day}
                  />
                </div>
              ) : (
                <p className="mt-3 rounded-lg border border-line bg-bg/55 px-3 py-2 text-sm text-ink-2">
                  Tidak ada rencana masuk: {plan && !isActivePlan(plan) ? plan.reason : "–"}
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-line bg-panel/90 p-4 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
              <h2 className="mb-2 text-sm font-semibold text-ink">Jam ramai (WIB)</h2>
              <BusyHours pool={address} />
            </section>

            <section className="rounded-2xl border border-line bg-panel/90 p-4 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
              <h2 className="text-sm font-semibold text-ink">Keputusan per profil</h2>
              <p className="mt-0.5 text-xs text-ink-3">Slot posisi dan cooldown bisa menunda masuk yang diizinkan aturan.</p>
              <ul className="mt-1 divide-y divide-line">
                {(detail.data?.profiles ?? []).map((d) => (
                  <DecisionRow key={d.key} d={d} />
                ))}
              </ul>
            </section>
          </aside>
        </div>

        <section className="overflow-hidden rounded-2xl border border-line bg-panel/90 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Posisi paper di pool ini</h2>
            <span className="text-xs text-ink-3">Semua profil · ditandai panah di grafik</span>
          </div>
          {(paper.data?.positions ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-3">Belum ada posisi paper di pool ini.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm tabular-nums">
                <thead className="text-[11px] uppercase tracking-wider text-ink-3">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2.5 text-left font-medium">Profil</th>
                    <th className="px-3 py-2.5 text-left font-medium">Status</th>
                    <th className="px-3 py-2.5 text-left font-medium">Masuk</th>
                    <th className="px-3 py-2.5 text-right font-medium">Modal</th>
                    <th className="px-3 py-2.5 text-right font-medium">Min – max price</th>
                    <th className="px-3 py-2.5 text-left font-medium">Keluar</th>
                    <th className="px-4 py-2.5 text-right font-medium">PnL bersih</th>
                  </tr>
                </thead>
                <tbody>
                  {(paper.data?.positions ?? []).map((p) => (
                    <tr key={p.id} className="border-b border-line/70 last:border-b-0">
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-2 text-ink">
                          <span className="h-0.5 w-3 rounded-full" style={{ background: PROFILE_COLORS[p.profile] }} aria-hidden />
                          {detail.data?.profiles.find((d) => d.key === p.profile)?.label ?? p.profile}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-ink-2">{p.status === "open" ? "Terbuka" : "Ditutup"}</td>
                      <td className="px-3 py-2.5 text-ink-2">{fmtDateTime(p.entry_ts)}</td>
                      <td className="px-3 py-2.5 text-right text-ink-2">{usd.format(p.capital_usd)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-2">
                        {fmtPriceExact(p.min_price)} – {fmtPriceExact(p.max_price)}
                      </td>
                      <td className="px-3 py-2.5 text-ink-2">
                        {p.exit_ts ? `${fmtDateTime(p.exit_ts)} · ${EXIT_LABEL[p.exit_reason ?? ""] ?? p.exit_reason}` : "–"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Delta value={p.pnl_pct} digits={2} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
