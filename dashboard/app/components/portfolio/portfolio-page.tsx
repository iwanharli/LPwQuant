"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CLAIM_URL, ENGINE_URL, fmtDateTime, fmtTime, fmtNum, shortAddress, usd } from "../../lib/format";
import { logActivity } from "../../lib/tx";
import { useUrlState } from "../../lib/url-state";
import { canSign, signAndSendAll, useConnectedWallet, useWalletOptions, useWalletParam } from "../../lib/wallet";
import TopBar from "../top-bar";
import { StatusDot } from "../ui";
import WalletButton from "../wallet-button";
import DailyPnlChart, { type DailyPnl } from "./daily-pnl-chart";
import PoolCard, { type Pool } from "./pool-card";
import { ClosedPositions } from "./closed-history";
import AutoCloseToggle from "./auto-close";
import CloseSellButton from "./close-sell";
import NetPnl from "./net-pnl";
import PortfolioHeader from "./portfolio-header";
import PortfolioTabs from "./portfolio-tabs";
import PositionFilters, { DEFAULT_FILTERS, applyFilters, statusCounts, type Filters } from "./position-filters";

const REFRESH_MS = 20_000;

type Portfolio = {
  wallet: string;
  fetched_at: number;
  summary: {
    value_usd: number;
    value_sol: number;
    deposit_usd: number;
    unclaimed_fees_usd: number;
    open_pnl_usd: number;
    open_pnl_sol: number;
    positions: number;
    out_of_range: number;
    closed_pnl_usd: number;
    closed_pnl_sol: number;
    closed_positions: number;
    sol_price: number | null;
  };
  pools: Pool[];
  daily: DailyPnl[];
  tracking_since: number | null;
};

function usePortfolio(wallet: string | undefined) {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    let first = true;
    const load = async () => {
      try {
        // After a claim the first load skips the engine's one-minute cache, so the fees drop right away.
        const fresh = first && reloadKey > 0;
        first = false;
        const res = await fetch(`${ENGINE_URL}/api/portfolio?wallet=${wallet}${fresh ? "&fresh=true" : ""}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setData(body as Portfolio);
          setError(null);
          setLoadedFor(wallet);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Gagal memuat");
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [wallet, reloadKey]);

  // A different wallet: do not show the previous one's numbers while the new one loads.
  return { data: loadedFor === wallet ? data : null, error, reload: () => setReloadKey((k) => k + 1), reloadKey };
}

export type ClaimItem = { position: string; pool: string; poolName: string; tokenX: string; tokenY: string; usd: number };
type BuiltClaim = {
  position: string;
  pool: string;
  fee_x_ui: number;
  fee_y_ui: number;
  transactions: string[];
  network_fee_lamports: number;
};
type Review = { items: ClaimItem[]; claims: BuiltClaim[]; skipped: string[]; builtAt: number };

type ClaimState =
  | { phase: "idle" }
  | { phase: "building"; key: string; items: ClaimItem[] }
  | { phase: "signing"; key: string }
  | { phase: "review"; key: string; review: Review }
  | { phase: "done"; key: string; signatures: string[]; skipped: number; received: [string, number][] }
  | { phase: "error"; key: string; message: string };

// A transaction carries a recent blockhash that expires after ~60-90s; past this, rebuild before signing.
const REBUILD_AFTER_MS = 45_000;

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Gagal";
  if (/reject|cancel|denied|declined/i.test(message)) return "Dibatalkan di wallet";
  if (/429|too many requests|rate limit/i.test(message)) return "RPC sedang sibuk (rate limit). Coba lagi sebentar lagi.";
  if (/failed to fetch|networkerror/i.test(message)) return "Ingestor tidak bisa dihubungi. Pastikan ingestor berjalan.";
  return message;
}

/** Tokens a claim pays out, summed across positions: several pools can pay the same token. */
function receivedTotals(review: Review): [string, number][] {
  const byPosition = new Map(review.items.map((i) => [i.position, i]));
  const totals = new Map<string, number>();
  for (const c of review.claims) {
    const item = byPosition.get(c.position);
    if (!item) continue;
    if (c.fee_x_ui > 0) totals.set(item.tokenX, (totals.get(item.tokenX) ?? 0) + c.fee_x_ui);
    if (c.fee_y_ui > 0) totals.set(item.tokenY, (totals.get(item.tokenY) ?? 0) + c.fee_y_ui);
  }
  return [...totals.entries()];
}

async function buildClaims(owner: string, items: ClaimItem[]): Promise<Review> {
  const res = await fetch(`${CLAIM_URL}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, positions: items.map(({ position, pool }) => ({ position, pool })) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
  return { items, claims: body.claims, skipped: body.skipped ?? [], builtAt: Date.now() };
}

/**
 * Claim flow: the ingestor builds and simulates unsigned transactions, the page shows what each one claims and
 * waits for the user to confirm, and only then does the wallet see them (and ask again, with its own simulation).
 */
function useClaim(owner: string | undefined, onDone: () => void) {
  const [state, setState] = useState<ClaimState>({ phase: "idle" });
  const cancelRef = useRef<() => void>(() => undefined);

  const prepare = async (key: string, items: ClaimItem[]) => {
    if (!owner || items.length === 0) return;
    setState({ phase: "building", key, items });
    let cancelled = false;
    cancelRef.current = () => (cancelled = true);
    try {
      const review = await buildClaims(owner, items);
      if (cancelled) return; // closed while the transactions were still being built
      if (review.claims.length === 0) {
        setState({ phase: "done", key, signatures: [], skipped: review.skipped.length, received: [] });
        return;
      }
      setState({ phase: "review", key, review });
    } catch (err) {
      if (!cancelled) setState({ phase: "error", key, message: friendlyError(err) });
    }
  };

  const confirm = async () => {
    if (state.phase !== "review" || !owner) return;
    const { key } = state;
    let { review } = state;
    setState({ phase: "signing", key });
    try {
      if (Date.now() - review.builtAt > REBUILD_AFTER_MS) review = await buildClaims(owner, review.items);
      const txs = review.claims.flatMap((c) => c.transactions.map((t) => Uint8Array.from(atob(t), (ch) => ch.charCodeAt(0))));
      const signatures = await signAndSendAll(txs);
      setState({ phase: "done", key, signatures, skipped: review.skipped.length, received: receivedTotals(review) });
      logActivity({
        wallet: owner,
        kind: "claim",
        signatures,
        pool: review.claims.length === 1 ? review.claims[0].pool : undefined,
        note: receivedTotals(review).map(([t, a]) => `+${a.toPrecision(4)} ${t}`).join(" · "),
      });
      setTimeout(() => {
        onDone();
        // Also drop the ingestor's wallet cache, so the Wallet tab shows the claimed tokens on its next load.
        void fetch(`${CLAIM_URL}/wallet?owner=${owner}&fresh=1`).catch(() => undefined);
      }, 4000); // give the chain and Meteora's indexer a moment before re-reading
    } catch (err) {
      setState({ phase: "error", key, message: friendlyError(err) });
    }
  };

  const cancel = useCallback(() => {
    cancelRef.current();
    setState({ phase: "idle" });
  }, []);
  return { state, prepare, confirm, cancel };
}

function ClaimReview({
  review,
  building,
  onConfirm,
  onCancel,
}: {
  review: Review | null;
  /** Positions being built, shown while `review` is still null. */
  building?: ClaimItem[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const items = review?.items ?? building ?? [];
  const byPosition = new Map(items.map((i) => [i.position, i]));
  const claims = review?.claims ?? [];
  const txCount = claims.reduce((n, c) => n + c.transactions.length, 0);
  const feeSol = claims.reduce((n, c) => n + c.network_fee_lamports, 0) / 1e9;
  const usdTotal = claims.reduce((n, c) => n + (byPosition.get(c.position)?.usd ?? 0), 0);
  // Same token claimed from several positions: one total per token, so two-token fees read at a glance.
  const totals = new Map(review ? receivedTotals(review) : []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 px-4 backdrop-blur-sm" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-review-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
      >
        <div className="border-b border-line px-5 py-4">
          <h2 id="claim-review-title" className="text-base font-semibold text-ink">
            Rincian claim fee
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">Periksa dulu. Setelah lanjut, Jupiter akan menampilkan simulasinya lagi.</p>
        </div>

        {!review && (
          <div className="px-5 py-4">
            <div className="flex items-center gap-3 rounded-xl border border-line bg-black/25 px-3.5 py-3 text-sm text-ink-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-hidden />
              Menyiapkan dan mensimulasikan {items.length} transaksi…
            </div>
            <ul className="mt-2 space-y-1 text-xs text-ink-3">
              {items.map((i) => (
                <li key={i.position} className="flex justify-between">
                  <span>{i.poolName.replace("-", "/")}</span>
                  <span className="tabular-nums">≈ {usd.format(i.usd)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {review && (
        <div className="max-h-[50vh] space-y-2 overflow-y-auto px-5 py-4">
          {claims.map((c) => {
            const item = byPosition.get(c.position);
            return (
              <div key={c.position} className="rounded-xl border border-line bg-black/25 px-3.5 py-3">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-ink">{item?.poolName.replace("-", "/") ?? "Posisi"}</span>
                  <span className="font-mono text-[11px] text-ink-3">{shortAddress(c.position)}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm tabular-nums">
                  <div className="rounded-lg bg-raised/40 px-2.5 py-1.5">
                    <div className="text-[11px] text-ink-3">{item?.tokenX}</div>
                    <div className={c.fee_x_ui > 0 ? "text-ink" : "text-ink-3"}>+{fmtNum(c.fee_x_ui, c.fee_x_ui < 1 ? 6 : 4)}</div>
                  </div>
                  <div className="rounded-lg bg-raised/40 px-2.5 py-1.5">
                    <div className="text-[11px] text-ink-3">{item?.tokenY}</div>
                    <div className={c.fee_y_ui > 0 ? "text-ink" : "text-ink-3"}>+{fmtNum(c.fee_y_ui, c.fee_y_ui < 1 ? 6 : 4)}</div>
                  </div>
                </div>
                {item && <div className="mt-1.5 text-right text-[11px] text-ink-3">≈ {usd.format(item.usd)}</div>}
              </div>
            );
          })}
        </div>
        )}

        {review && (
        <div className="space-y-1.5 border-t border-line bg-black/20 px-5 py-4 text-sm tabular-nums">
          <div className="flex items-start justify-between gap-4">
            <span className="text-ink-3">Total diterima</span>
            <span className="text-right text-ink">
              {[...totals.entries()].map(([token, amount]) => (
                <span key={token} className="block">
                  +{fmtNum(amount, amount < 1 ? 6 : 4)} {token}
                </span>
              ))}
              <span className="block text-xs text-ink-3">≈ {usd.format(usdTotal)}</span>
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-ink-3">Transaksi</span>
            <span className="text-ink-2">{txCount}×, disetujui di wallet</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-ink-3">Biaya jaringan</span>
            <span className="text-ink-2">≈ {fmtNum(feeSol, 6)} SOL</span>
          </div>
          {review && review.skipped.length > 0 && (
            <div className="text-xs text-ink-3">{review.skipped.length} posisi dilewati karena fee-nya nol.</div>
          )}
        </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-line px-4 py-2 text-sm text-ink-2 hover:border-line-strong hover:text-ink"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!review}
            autoFocus
            className="btn-accent rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-50"
          >
            Lanjut ke wallet
          </button>
        </div>
      </div>
    </div>
  );
}

function ClaimButton({
  label,
  busyKey,
  state,
  disabled,
  onClick,
}: {
  label: string;
  busyKey: string;
  state: ClaimState;
  disabled: boolean;
  onClick: () => void;
}) {
  const mine = state.phase !== "idle" && state.key === busyKey;
  const busy = state.phase === "building" || state.phase === "signing";
  const text = mine && state.phase === "building" ? "Menyiapkan…" : mine && state.phase === "signing" ? "Setujui di wallet…" : label;
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className="btn-accent rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45"
    >
      {text}
    </button>
  );
}

function ClaimResult({ state }: { state: ClaimState }) {
  if (state.phase === "done") {
    return (
      <p className="flex flex-wrap items-center gap-2 rounded-2xl border border-good/30 bg-good/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
        <StatusDot severity="good" />
        {state.signatures.length === 0
          ? "Tidak ada fee untuk di-claim."
          : `Fee di-claim lewat ${state.signatures.length} transaksi.`}
        {state.signatures.map((sig) => (
          <a key={sig} href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent hover:underline">
            {shortAddress(sig)} ↗
          </a>
        ))}
        {state.skipped > 0 && <span className="text-xs text-ink-3">{state.skipped} posisi dilewati (fee nol)</span>}
        {state.received.length > 0 && (
          <span className="basis-full pl-4 text-xs leading-5 text-ink-2">
            Masuk ke wallet:{" "}
            {state.received.map(([token, amount], i) => (
              <span key={token} className="tabular-nums">
                {i > 0 && " · "}+{fmtNum(amount, amount < 1 ? 6 : 4)} <span className="font-medium text-ink">{token}</span>
              </span>
            ))}
            <span className="text-ink-3">
              {" "}
              — token bernilai di bawah $1 ada di kelompok Debu di tab Wallet, dan aplikasi wallet sering menyembunyikannya.
            </span>
          </span>
        )}
      </p>
    );
  }
  if (state.phase === "error") {
    return (
      <p className="flex items-center gap-2 rounded-2xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
        <StatusDot severity="critical" /> Claim gagal: {state.message}
      </p>
    );
  }
  return null;
}

const signedUsd = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const signedSol = (v: number) => `${v >= 0 ? "+" : "−"}${fmtNum(Math.abs(v), 4)} SOL`;
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink-2");

function Tile({ label, value, hint }: { label: ReactNode; value: ReactNode; hint: ReactNode }) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-2xl border border-line bg-panel backdrop-blur-sm px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
      <div className="flex min-w-0 items-center gap-2 truncate text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-ink">{value}</div>
      <div className="mt-1 truncate text-xs text-ink-3">{hint}</div>
    </div>
  );
}

function Card({
  title,
  right,
  collapsedRight,
  defaultOpen = true,
  children,
}: {
  title: string;
  right?: ReactNode;
  /** Shown in the header while collapsed, in place of `right`. */
  collapsedRight?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel backdrop-blur-sm shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full flex-wrap items-center justify-between gap-3 bg-raised/20 px-4 py-3 text-left transition-colors hover:bg-raised/40 ${open ? "border-b border-line" : ""}`}
      >
        <span className="flex items-center gap-2">
          <svg viewBox="0 0 20 20" width={14} height={14} className={`text-ink-3 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden>
            <path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
        </span>
        {open ? right : (collapsedRight ?? right)}
      </button>
      {open && children}
    </section>
  );
}

/** Manual refresh: skips the engine and ingestor caches once. Spins until data newer than the click arrives. */
function RefreshButton({ onClick, fetchedAt }: { onClick: () => void; fetchedAt: number }) {
  const [clickedAt, setClickedAt] = useState<number | null>(null);
  const busy = clickedAt != null && fetchedAt < clickedAt;
  return (
    <button
      type="button"
      onClick={() => {
        setClickedAt(Date.now());
        onClick();
      }}
      disabled={busy}
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-sm font-medium text-ink-2 shadow-sm shadow-black/20 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-70"
    >
      <svg viewBox="0 0 20 20" width={15} height={15} className={busy ? "animate-spin" : ""} aria-hidden>
        <path
          d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.2h-3.2"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {busy ? "Memuat…" : "Refresh"}
    </button>
  );
}

/** One quiet line under the filters when a position needs a look; each part filters the list to those positions. */
function RangeNotice({
  counts,
  onShow,
}: {
  counts: ReturnType<typeof statusCounts>;
  onShow: (status: "out" | "near_edge") => void;
}) {
  const parts = [
    counts.out > 0 && { status: "out" as const, dot: "bg-critical", text: `${counts.out} di luar range, tidak mengumpulkan fee` },
    counts.near_edge > 0 && { status: "near_edge" as const, dot: "bg-warning", text: `${counts.near_edge} dekat tepi range` },
  ].filter(Boolean) as { status: "out" | "near_edge"; dot: string; text: string }[];
  if (parts.length === 0) return null;
  return (
    <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-ink-3">
      {parts.map((p) => (
        <button key={p.status} type="button" onClick={() => onShow(p.status)} className="inline-flex items-center gap-1.5 hover:text-ink">
          <span className={`h-1.5 w-1.5 rounded-full ${p.dot}`} aria-hidden />
          {p.text}
          <span className="text-ink-3/70">→</span>
        </button>
      ))}
    </div>
  );
}

type View = "open" | "history";
const VIEWS = ["open", "history"] as const;
const GROUPINGS = ["coin", "pool"] as const;

/** Open positions, or the history of closed positions and finished limit orders, on the same tab. */
/**
 * One place for "what happened": by coin (every transaction, including coins never put in a pool) or by LP pool
 * (what each position did inside its range). They answer different questions on the same wallet, so they live
 * behind one switch instead of two tabs that sound alike.
 */
function HistoryAndNet({ wallet }: { wallet: string }) {
  const [by, setBy] = useUrlState<"coin" | "pool">("by", "coin", GROUPINGS);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-xl border border-line bg-panel p-1" role="tablist" aria-label="Kelompokkan">
          {([
            { key: "coin", label: "Per koin" },
            { key: "pool", label: "Per pool LP" },
          ] as const).map((o) => (
            <button
              key={o.key}
              type="button"
              role="tab"
              aria-selected={by === o.key}
              onClick={() => setBy(o.key)}
              className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                by === o.key ? "bg-accent/15 text-accent" : "text-ink-2 hover:bg-raised/50 hover:text-ink"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-3">
          {by === "coin"
            ? "Semua transaksi tiap koin: beli, LP, jual, dan yang masih dipegang. Termasuk koin yang tidak pernah di-LP."
            : "Tiap posisi LP menurut Meteora: fee, IL, berapa lama harganya di dalam range, dan keluar lewat mana."}
        </p>
      </div>
      {by === "coin" ? <NetPnl wallet={wallet} /> : <ClosedPositions wallet={wallet} />}
    </div>
  );
}

function ViewSwitch({ view, onChange, openCount }: { view: View; onChange: (v: View) => void; openCount: number | null }) {
  const options: { value: View; label: string }[] = [
    { value: "open", label: openCount != null ? `Posisi terbuka (${openCount})` : "Posisi terbuka" },
    { value: "history", label: "Riwayat & hasil" },
  ];
  return (
    <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Tampilan posisi">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={view === o.value}
          onClick={() => onChange(o.value)}
          className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            view === o.value ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center rounded-2xl border border-line bg-panel backdrop-blur-sm px-6 py-16 text-center shadow-[0_14px_42px_rgba(0,0,0,0.20)]">
      <div className="max-w-md">
        <div className="text-lg font-semibold text-ink">Hubungkan wallet untuk melihat posisi LP</div>
        <p className="mt-2 text-sm leading-6 text-ink-3">
          Pakai Jupiter Wallet (atau Phantom, Solflare, dan lainnya). Aplikasi ini hanya membaca alamat publik: tidak
          ada transaksi atau tanda tangan yang diminta.
        </p>
        <div className="mt-5 flex justify-center">
          <WalletButton />
        </div>
      </div>
    </div>
  );
}

export default function PortfolioPage() {
  const connected = useConnectedWallet();
  useWalletParam(connected);
  const { data, error, reload, reloadKey } = usePortfolio(connected?.address);
  const walletOptions = useWalletOptions();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [view, setView] = useUrlState<View>("view", "open", VIEWS);
  const visiblePools = applyFilters(data?.pools ?? [], filters);
  const visibleCount = visiblePools.reduce((n, pool) => n + pool.positions.length, 0);
  const signer = canSign(connected, walletOptions);
  const { state: claimState, prepare, confirm, cancel } = useClaim(connected?.address, reload);
  const claimItem = (pool: Pool, p: Pool["positions"][number]): ClaimItem => ({
    position: p.address,
    pool: pool.address,
    poolName: pool.name,
    tokenX: pool.token_x,
    tokenY: pool.token_y,
    usd: p.unclaimed_fees_usd,
  });
  const allPositions = (data?.pools ?? []).flatMap((pool) =>
    pool.positions.filter((p) => p.unclaimed_fees_usd > 0).map((p) => claimItem(pool, p)),
  );
  const s = data?.summary;
  const today = data?.daily[data.daily.length - 1];
  const lifetime = s ? s.open_pnl_usd + s.closed_pnl_usd : 0;

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PortfolioHeader
          subtitle="Posisi DLMM di wallet kamu."
          right={
            data && (
              <>
              <div className="text-right text-xs text-ink-3">
                <div className="font-mono text-ink-2">{shortAddress(data.wallet)}</div>
                diperbarui {fmtTime(data.fetched_at)} · otomatis tiap {REFRESH_MS / 1000} dtk
              </div>
              <RefreshButton onClick={reload} fetchedAt={data.fetched_at} />
              </>
            )
          }
        />

        <PortfolioTabs />

        {!connected ? (
          <EmptyState />
        ) : (
          <>
            <ViewSwitch view={view} onChange={setView} openCount={data?.summary.positions ?? null} />
            {view === "history" && <HistoryAndNet wallet={connected.address} />}
            {view === "open" && (
          <>
            {error && (
              <p className="flex items-center gap-2 rounded-2xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
                <StatusDot severity="critical" /> {error}. Pastikan engine berjalan di {ENGINE_URL}.
              </p>
            )}

            <ClaimResult state={claimState} />
            {(claimState.phase === "review" || claimState.phase === "building") && (
              <ClaimReview
                review={claimState.phase === "review" ? claimState.review : null}
                building={claimState.phase === "building" ? claimState.items : undefined}
                onConfirm={() => void confirm()}
                onCancel={cancel}
              />
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <Tile
                label="Nilai posisi"
                value={s ? usd.format(s.value_usd) : "–"}
                hint={s ? `${fmtNum(s.value_sol, 3)} SOL · ${s.positions} posisi` : "Memuat…"}
              />
              <Tile
                label="Keuntungan hari ini"
                value={today ? <span className={tone(today.pnl_usd)}>{signedUsd(today.pnl_usd)}</span> : "–"}
                hint={today?.partial ? "Dihitung sejak mulai dipantau hari ini" : "Sejak tutup hari kemarin (WIB)"}
              />
              <Tile
                label="PnL posisi terbuka"
                value={s ? <span className={tone(s.open_pnl_usd)}>{signedUsd(s.open_pnl_usd)}</span> : "–"}
                hint={s ? `${signedSol(s.open_pnl_sol)} · modal ${usd.format(s.deposit_usd)}` : ""}
              />
              <Tile
                label="Fee belum di-claim"
                value={s ? usd.format(s.unclaimed_fees_usd) : "–"}
                hint={
                  <span className="flex items-center gap-2">
                    <ClaimButton
                      label={`Claim semua (${allPositions.length})`}
                      busyKey="all"
                      state={claimState}
                      disabled={!signer || allPositions.length === 0}
                      onClick={() => void prepare("all", allPositions.slice(0, 20))}
                    />
                    <span className="truncate">{signer ? "Sudah termasuk di PnL" : "Connect lewat extension untuk claim"}</span>
                  </span>
                }
              />
              <Tile
                label="PnL sepanjang waktu"
                value={s ? <span className={tone(lifetime)}>{signedUsd(lifetime)}</span> : "–"}
                hint={s ? `${signedUsd(s.closed_pnl_usd)} dari ${s.closed_positions} posisi ditutup` : ""}
              />
            </div>

            <Card
              title="Keuntungan per hari"
              defaultOpen={false}
              collapsedRight={
                today ? (
                  <span className="flex items-center gap-3 text-xs tabular-nums">
                    <span className="text-ink-3">Hari ini</span>
                    <span className={`font-medium ${tone(today.pnl_usd)}`}>{signedUsd(today.pnl_usd)}</span>
                    <span className="text-ink-3">· {data?.daily.length} hari tercatat</span>
                  </span>
                ) : undefined
              }
              right={
                <span className="text-xs text-ink-3">
                  {data?.tracking_since ? `Dipantau sejak ${fmtDateTime(data.tracking_since)} WIB` : ""}
                </span>
              }
            >
              <div className="px-2 py-3 sm:px-4">
                {data && data.daily.length > 0 ? (
                  <>
                    <DailyPnlChart days={data.daily} />
                    {data.daily.length < 2 && (
                      <p className="px-2 pt-2 text-xs text-ink-3">
                        Grafik terisi satu batang per hari. Hari pertama (pudar) hanya dihitung sejak mulai dipantau.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="px-2 py-8 text-sm text-ink-3">{data ? "Belum ada data." : "Memuat…"}</p>
                )}
              </div>
            </Card>

            {data && data.pools.length === 0 && (
              <p className="rounded-2xl border border-line bg-panel backdrop-blur-sm px-4 py-8 text-center text-sm text-ink-3">
                Tidak ada posisi DLMM terbuka di wallet ini.
              </p>
            )}
            {data && data.pools.length > 0 && (
              <PositionFilters
                filters={filters}
                onChange={setFilters}
                counts={statusCounts(data.pools)}
                shown={visibleCount}
              />
            )}
            {data && data.pools.length > 0 && (
              <RangeNotice counts={statusCounts(data.pools)} onShow={(status) => setFilters({ ...filters, status })} />
            )}
            {data && data.pools.length > 0 && visiblePools.length === 0 && (
              <p className="rounded-2xl border border-line bg-panel px-4 py-8 text-center text-sm text-ink-3">
                Tidak ada posisi yang cocok dengan filter.{" "}
                <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} className="text-accent hover:underline">
                  Reset filter
                </button>
              </p>
            )}
            {visiblePools.map((pool) => (
              <PoolCard
                key={pool.address}
                pool={pool}
                refreshKey={reloadKey}
                wallet={connected?.address}
                renderClaim={(p) => (
                  <span className="inline-flex flex-wrap justify-end gap-2">
                    <ClaimButton
                      label={`Claim fee ${usd.format(p.unclaimed_fees_usd)}`}
                      busyKey={p.address}
                      state={claimState}
                      disabled={!signer || p.unclaimed_fees_usd <= 0}
                      onClick={() => void prepare(p.address, [claimItem(pool, p)])}
                    />
                    <CloseSellButton
                      owner={connected?.address}
                      pool={pool.address}
                      position={p.address}
                      poolName={pool.name}
                      tokenX={pool.token_x}
                      tokenY={pool.token_y}
                      valueUsd={p.value_usd + p.unclaimed_fees_usd}
                      disabled={!signer}
                      onDone={reload}
                    />
                    <AutoCloseToggle owner={connected?.address} pool={pool.address} position={p.address} />
                  </span>
                )}
              />
            ))}
          </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
