"use client";

import { useEffect, useState } from "react";
import { CLAIM_URL, ENGINE_URL, fmtDateTime, fmtNum, fmtSignedPct, shortAddress, usd } from "../../lib/format";
import { StatusDot } from "../ui";

export type Position = {
  address: string;
  lower_bin: number;
  upper_bin: number;
  active_bin: number | null;
  min_price: number;
  max_price: number;
  out_of_range: boolean | null;
  created_at: number | null;
  value_usd: number;
  value_sol: number;
  amount_x: number;
  amount_y: number;
  unclaimed_fee_x: number;
  unclaimed_fee_y: number;
  unclaimed_fees_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  pnl_sol: number;
  pnl_sol_pct: number;
};

export type Pool = {
  address: string;
  name: string;
  token_x: string;
  token_y: string;
  token_x_icon: string | null;
  token_y_icon: string | null;
  bin_step: number;
  value_usd: number;
  value_sol: number;
  pnl_usd: number;
  pnl_pct: number;
  open_positions: number;
  fee_tvl_24h: number;
  positions: Position[];
};

type Bins = { active_bin: number; lower_bin: number; upper_bin: number; bins: { bin: number; price: number; x: number; y: number }[] };

// Token side vs quote side of a position: identity, not status, so neither is a status color.
const TOKEN_COLOR = "#8b6cf6";
const QUOTE_COLOR = "#3ec6e0";
const NEAR_EDGE = 0.15; // within 15% of the range edge: one move from out of range

const signedUsd = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const signedSol = (v: number) => `${v >= 0 ? "+" : "−"}${fmtNum(Math.abs(v), 4)} SOL`;
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink-2");

/** Where the price sits in the range, 0 at the lower edge and 1 at the upper, and what that means. */
export function rangeStatus(p: Position, active: number | null) {
  const span = Math.max(1, p.upper_bin - p.lower_bin);
  const pos = active == null ? null : (active - p.lower_bin) / span;
  if (pos == null) return { pos, severity: "info" as const, label: "–", hint: "Active bin belum diketahui" };
  if (pos < 0 || p.out_of_range === true && pos < 0.5)
    return { pos, severity: "critical" as const, label: "Di bawah range", hint: "Harga turun di bawah range: posisi penuh token, tidak mengumpulkan fee" };
  if (pos > 1 || p.out_of_range === true)
    return { pos, severity: "critical" as const, label: "Di atas range", hint: "Harga naik di atas range: posisi penuh SOL/quote, tidak mengumpulkan fee" };
  if (pos < NEAR_EDGE || pos > 1 - NEAR_EDGE)
    return { pos, severity: "warning" as const, label: "Dekat tepi", hint: "Harga dekat tepi range: satu gerakan lagi posisi keluar range" };
  return { pos, severity: "good" as const, label: "In range", hint: "Harga di dalam range: posisi mengumpulkan fee" };
}

const SEVERITY_CHIP = {
  good: "border-good/35 bg-good/10 text-good",
  warning: "border-warning/35 bg-warning/10 text-warning",
  critical: "border-critical/40 bg-critical/10 text-critical",
  info: "border-line bg-raised/70 text-ink-2",
} as const;
const SEVERITY_BAR = { good: "bg-good", warning: "bg-warning", critical: "bg-critical", info: "bg-ink-3" } as const;

function useBins(pool: string, position: string, open: boolean, refreshKey: number) {
  const [data, setData] = useState<Bins | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let first = refreshKey > 0; // a manual refresh skips the ingestor's cache once
    const load = async () => {
      try {
        const fresh = first ? "&fresh=1" : "";
        first = false;
        const res = await fetch(`${CLAIM_URL}/bins?pool=${pool}&position=${position}${fresh}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Bins;
        if (!cancelled) {
          setData(body);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pool, position, open, refreshKey]);
  return { data, failed };
}

type PnlPoint = { ts: number; pnl_usd: number };

function usePositionHistory(wallet: string | undefined, position: string, open: boolean) {
  const [points, setPoints] = useState<PnlPoint[] | null>(null);
  useEffect(() => {
    if (!open || !wallet) return;
    let cancelled = false;
    fetch(`${ENGINE_URL}/api/portfolio/position-history?wallet=${wallet}&position=${position}&days=30`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => !cancelled && body && setPoints(body.series as PnlPoint[]))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wallet, position, open]);
  return points;
}

/** PnL of one position since the engine started snapshotting it, as a small line: is it earning or bleeding. */
function PnlSparkline({ points }: { points: PnlPoint[] }) {
  if (points.length < 2) {
    return <span className="text-[11px] text-ink-3">Riwayat PnL muncul setelah beberapa snapshot (tiap 15 menit).</span>;
  }
  const w = 240;
  const h = 36;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.pnl_usd);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys, 0), Math.max(...ys, 0)];
  const sx = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * w;
  const sy = (y: number) => h - ((y - y0) / Math.max(1e-9, y1 - y0)) * h;
  const path = points.map((p, i) => `${i ? "L" : "M"}${sx(p.ts).toFixed(1)},${sy(p.pnl_usd).toFixed(1)}`).join(" ");
  const last = ys[ys.length - 1];
  const change = last - ys[0];
  return (
    <span className="flex items-center gap-3">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" role="img" aria-label="PnL posisi sejak dipantau">
        <line x1={0} x2={w} y1={sy(0)} y2={sy(0)} stroke="currentColor" className="text-line" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={last >= 0 ? "var(--color-up)" : "var(--color-down)"} strokeWidth={1.6} strokeLinejoin="round" />
      </svg>
      <span className="text-[11px] tabular-nums text-ink-3">
        PnL sejak dipantau{" "}
        <span className={change >= 0 ? "text-up" : "text-down"}>
          {change >= 0 ? "+" : "−"}
          {usd.format(Math.abs(change))}
        </span>
      </span>
    </span>
  );
}

function TokenPair({ pool, size = 28 }: { pool: Pool; size?: number }) {
  return (
    <span className="flex shrink-0 -space-x-2.5">
      {[pool.token_x_icon, pool.token_y_icon].map((src, i) =>
        src ? (
          // eslint-disable-next-line @next/next/no-img-element -- token icons come from many hosts
          <img
            key={i}
            src={src}
            alt=""
            width={size}
            height={size}
            style={{ width: size, height: size }}
            className="rounded-full border-2 border-panel bg-raised object-cover"
          />
        ) : (
          <span key={i} style={{ width: size, height: size }} className="rounded-full border-2 border-panel bg-raised" />
        ),
      )}
    </span>
  );
}

function BinChart({ pool, bins }: { pool: Pool; bins: Bins }) {
  const values = bins.bins.map((b) => b.x * b.price + b.y);
  const max = Math.max(...values, 1e-12);
  return (
    <div>
      <div className="flex h-28 items-end gap-[2px] rounded-lg bg-black/35 px-2 pt-3" role="img" aria-label="Likuiditas posisi per bin">
        {bins.bins.map((b, i) => {
          const isActive = b.bin === bins.active_bin;
          const color = isActive ? "#f4f6fa" : b.x > 0 && b.y === 0 ? TOKEN_COLOR : b.y > 0 && b.x === 0 ? QUOTE_COLOR : TOKEN_COLOR;
          const h = Math.max(3, (values[i] / max) * 100);
          return (
            <div
              key={b.bin}
              title={`Bin ${b.bin} · harga ${fmtNum(b.price, b.price < 1 ? 10 : 4)}\n${fmtNum(b.x, 2)} ${pool.token_x} · ${fmtNum(b.y, 4)} ${pool.token_y}`}
              className="relative min-w-[2px] flex-1 rounded-t-[3px] transition-opacity hover:opacity-80"
              style={{ height: `${h}%`, background: color }}
            >
              {isActive && <span className="absolute -top-2 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-ink-3">
        <span>Bin {bins.lower_bin}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: QUOTE_COLOR }} /> {pool.token_y}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: TOKEN_COLOR }} /> {pool.token_x}
          </span>
        </span>
        <span>Bin {bins.upper_bin}</span>
      </div>
    </div>
  );
}

function RangeMeter({ pos, severity }: { pos: number | null; severity: keyof typeof SEVERITY_BAR }) {
  const pct = pos == null ? null : Math.min(100, Math.max(0, pos * 100));
  return (
    <div className="flex items-center gap-3 text-[11px] tabular-nums text-ink-3">
      <span className="w-9">{pct == null ? "–" : `${pct.toFixed(0)}%`}</span>
      <div className="relative h-1.5 flex-1 rounded-full bg-raised">
        {pct != null && (
          <>
            <div className={`absolute inset-y-0 rounded-full ${SEVERITY_BAR[severity]}`} style={{ left: `${pct}%`, right: 0 }} />
            <span
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-white"
              style={{ left: `${pct}%` }}
            />
          </>
        )}
      </div>
      <span className="w-9 text-right">{pct == null ? "–" : `${(100 - pct).toFixed(0)}%`}</span>
    </div>
  );
}

function ActionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised/40 px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
    >
      {children} <span aria-hidden>↗</span>
    </a>
  );
}

function PositionBlock({
  pool,
  p,
  claimButton,
  refreshKey,
  wallet,
}: {
  pool: Pool;
  p: Position;
  claimButton: React.ReactNode;
  refreshKey: number;
  wallet?: string;
}) {
  const [open, setOpen] = useState(true);
  const { data: bins, failed } = useBins(pool.address, p.address, open, refreshKey);
  const history = usePositionHistory(wallet, p.address, open);
  const active = bins?.active_bin ?? p.active_bin;
  const st = rangeStatus(p, active);
  const span = p.upper_bin - p.lower_bin + 1;

  return (
    <div className={`border-t border-line/80 first:border-t-0 ${isSafe(p) ? "bg-emerald-400/[0.045] shadow-[inset_3px_0_0_rgba(52,211,153,0.7)]" : ""}`}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3.5 text-sm tabular-nums md:grid-cols-[1.3fr_1fr_0.6fr_1fr_1.1fr_1.2fr_auto] md:items-center">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-3 md:hidden">Likuiditas</div>
          <div className="font-semibold text-ink">{usd.format(p.value_usd)}</div>
          <div className="text-[11px] text-ink-3">
            {fmtNum(p.amount_x, 2)} {pool.token_x} · {fmtNum(p.amount_y, 4)} {pool.token_y}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-3 md:hidden">Bin range</div>
          <div className="text-ink">
            {p.lower_bin} – {p.upper_bin} <span className="text-ink-3">({span})</span>
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-3 md:hidden">Active bin</div>
          <div className="text-ink">{active ?? "–"}</div>
        </div>
        <div>
          <span
            title={st.hint}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${SEVERITY_CHIP[st.severity]}`}
          >
            <StatusDot severity={st.severity} />
            {st.label}
            {st.pos != null && st.pos >= 0 && st.pos <= 1 && <span className="opacity-80">{Math.round(st.pos * 100)}%</span>}
          </span>
        </div>
        <div className="md:text-right">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 md:hidden">Fee belum di-claim</div>
          <div className="font-medium text-ink">{usd.format(p.unclaimed_fees_usd)}</div>
          <div className="text-[11px] text-ink-3">
            {fmtNum(p.unclaimed_fee_x, 2)} {pool.token_x} · {fmtNum(p.unclaimed_fee_y, 4)} {pool.token_y}
          </div>
        </div>
        <div className="md:text-right">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 md:hidden">PnL</div>
          <div className={`font-semibold ${tone(p.pnl_usd)}`}>
            {signedUsd(p.pnl_usd)} <span className="text-xs font-normal">({fmtSignedPct(p.pnl_pct, 1)})</span>
          </div>
          <div className={`text-[11px] ${tone(p.pnl_sol)}`}>
            {signedSol(p.pnl_sol)} ({fmtSignedPct(p.pnl_sol_pct, 1)})
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Sembunyikan detail bin" : "Tampilkan detail bin"}
          className="col-span-2 justify-self-end rounded-md p-1.5 text-ink-3 hover:bg-raised/60 hover:text-ink md:col-span-1"
        >
          <svg viewBox="0 0 20 20" width={16} height={16} className={`transition-transform ${open ? "" : "rotate-180"}`} aria-hidden>
            <path d="m5 12.5 5-5 5 5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-line/60 bg-black/20 px-4 pb-4 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-ink-2">
              {span} bin <span className="text-ink-3">· dibuka {p.created_at ? fmtDateTime(p.created_at) : "–"}</span>
            </span>
            <span className={st.severity === "critical" ? "text-critical" : st.severity === "warning" ? "text-warning" : "text-ink-2"}>
              Active {active ?? "–"}
              {st.pos != null && st.pos >= 0 && st.pos <= 1 && (
                <span className="text-ink-3"> · {Math.round((1 - st.pos) * 100)}% range di atas harga</span>
              )}
            </span>
          </div>
          {bins ? (
            <BinChart pool={pool} bins={bins} />
          ) : (
            <div className="grid h-28 place-items-center rounded-lg bg-black/35 text-xs text-ink-3">
              {failed ? "Data bin tidak tersedia (ingestor mati?)" : "Memuat bin…"}
            </div>
          )}
          <RangeMeter pos={st.pos} severity={st.severity} />
          {history && <PnlSparkline points={history} />}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <ActionLink href={`https://meteora.ag/dlmm/${pool.address}`}>View on Meteora</ActionLink>
            <ActionLink href={`https://solscan.io/account/${p.address}`}>Posisi di Solscan</ActionLink>
            {claimButton}
            <span className="ml-auto font-mono text-[11px] text-ink-3">{shortAddress(p.address)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Meteora PnL at or above this has, in this wallet's closed positions, ended positive after swap costs and
 * slippage 93-100% of the time at every size; below it the outside-LP costs often turn it negative. */
export const SAFE_EXIT_PCT = 5;
const isSafe = (p: Position) => p.pnl_pct >= SAFE_EXIT_PCT;

function SafeChip() {
  return (
    <span
      title={`PnL Meteora ≥ +${SAFE_EXIT_PCT}%: dari riwayatmu, posisi seperti ini hampir selalu tetap untung setelah biaya swap dan slippage.`}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
    >
      <svg viewBox="0 0 16 16" width={11} height={11} aria-hidden>
        <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Aman dijual
    </span>
  );
}

export default function PoolCard({
  pool,
  renderClaim,
  refreshKey = 0,
  wallet,
}: {
  pool: Pool;
  renderClaim: (p: Position) => React.ReactNode;
  refreshKey?: number;
  wallet?: string;
}) {
  const safe = pool.positions.some(isSafe);
  return (
    <section
      className={`overflow-hidden rounded-2xl border backdrop-blur-sm transition-colors ${
        safe
          ? "border-emerald-400/45 bg-[#0c1512]/[0.97] shadow-[0_14px_42px_rgba(0,0,0,0.20),0_0_0_1px_rgba(52,211,153,0.08),inset_0_1px_0_rgba(110,231,183,0.10)]"
          : "border-line bg-[#0e1217]/[0.97] shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]"
      }`}
    >
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 ${
          safe ? "border-emerald-400/20 bg-gradient-to-r from-emerald-400/[0.14] via-emerald-400/[0.04] to-transparent" : "border-line bg-gradient-to-r from-[#8b6cf6]/12 via-raised/25 to-transparent"
        }`}
      >
        <TokenPair pool={pool} />
        <span className="text-base font-semibold text-ink">{pool.name.replace("-", "/")}</span>
        {safe && <SafeChip />}
        <span className="text-xs text-ink-3">{pool.bin_step}bps</span>
        <span className="text-sm tabular-nums text-ink-2">{fmtNum(pool.value_sol, 4)} SOL</span>
        <span className="text-xs text-ink-3">
          {pool.open_positions} posisi · fee/TVL 24j {fmtNum(pool.fee_tvl_24h, 2)}%
        </span>
        <span className="ml-auto flex items-center gap-4 tabular-nums">
          <span className="text-sm font-semibold text-ink">{usd.format(pool.value_usd)}</span>
          <span className={`text-sm font-semibold ${tone(pool.pnl_usd)}`}>
            {signedUsd(pool.pnl_usd)} <span className="text-xs font-normal">({fmtSignedPct(pool.pnl_pct, 1)})</span>
          </span>
        </span>
      </div>
      <div className="hidden grid-cols-[1.3fr_1fr_0.6fr_1fr_1.1fr_1.2fr_auto] gap-x-4 border-b border-line px-4 py-2 text-[11px] uppercase tracking-wider text-ink-3 md:grid">
        <span>Likuiditas</span>
        <span>Bin range</span>
        <span>Active</span>
        <span>Status</span>
        <span className="text-right">Fee belum di-claim</span>
        <span className="text-right">PnL</span>
        <span className="w-7" />
      </div>
      {pool.positions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-3">Detail posisi belum tersedia dari Meteora.</p>
      ) : (
        pool.positions.map((p) => <PositionBlock key={p.address} pool={pool} p={p} claimButton={renderClaim(p)} refreshKey={refreshKey} wallet={wallet} />)
      )}
    </section>
  );
}
