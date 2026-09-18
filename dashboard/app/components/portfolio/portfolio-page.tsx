"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CLAIM_URL, ENGINE_URL, fmtDateTime, fmtNum, shortAddress, usd } from "../../lib/format";
import { canSign, isWalletAddress, signAndSendAll, useConnectedWallet, useWalletOptions, watchAddress } from "../../lib/wallet";
import TopBar from "../top-bar";
import { StatusDot } from "../ui";
import WalletButton from "../wallet-button";
import DailyPnlChart, { type DailyPnl } from "./daily-pnl-chart";
import PoolCard, { type Pool } from "./pool-card";
import PositionFilters, { DEFAULT_FILTERS, applyFilters, statusCounts, type Filters } from "./position-filters";

const REFRESH_MS = 60_000;

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
  return { data: loadedFor === wallet ? data : null, error, reload: () => setReloadKey((k) => k + 1) };
}

type ClaimState =
  | { phase: "idle" }
  | { phase: "building" | "signing"; key: string }
  | { phase: "done"; key: string; signatures: string[]; skipped: number }
  | { phase: "error"; key: string; message: string };

/** Claim flow: the ingestor builds and simulates unsigned transactions, the wallet shows them and the user signs. */
function useClaim(owner: string | undefined, onDone: () => void) {
  const [state, setState] = useState<ClaimState>({ phase: "idle" });
  const claim = async (key: string, positions: { position: string; pool: string }[]) => {
    if (!owner || positions.length === 0) return;
    setState({ phase: "building", key });
    try {
      const res = await fetch(`${CLAIM_URL}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, positions }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
      const txs = (body.claims as { transactions: string[] }[]).flatMap((c) =>
        c.transactions.map((t) => Uint8Array.from(atob(t), (ch) => ch.charCodeAt(0))),
      );
      if (txs.length === 0) {
        setState({ phase: "done", key, signatures: [], skipped: body.skipped?.length ?? 0 });
        return;
      }
      setState({ phase: "signing", key });
      const signatures = await signAndSendAll(txs);
      setState({ phase: "done", key, signatures, skipped: body.skipped?.length ?? 0 });
      setTimeout(onDone, 4000); // give the chain and Meteora's indexer a moment before re-reading
    } catch (err) {
      const message = err instanceof Error ? err.message : "Gagal";
      const rejected = /reject|cancel|denied|declined/i.test(message);
      setState({ phase: "error", key, message: rejected ? "Dibatalkan di wallet" : message });
    }
  };
  return { state, claim };
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
      className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
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
    <div className="relative min-w-0 overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97] backdrop-blur-sm px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
      <div className="flex min-w-0 items-center gap-2 truncate text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-ink">{value}</div>
      <div className="mt-1 truncate text-xs text-ink-3">{hint}</div>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97] backdrop-blur-sm shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center rounded-2xl border border-line bg-[#0e1217]/[0.97] backdrop-blur-sm px-6 py-16 text-center shadow-[0_14px_42px_rgba(0,0,0,0.20)]">
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
  // /portfolio?wallet=<address> opens a wallet without an extension (a link from another device, say). It never
  // replaces a wallet connected through an extension.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("wallet");
    if (param && isWalletAddress(param) && !connected?.wallet && connected?.address !== param) watchAddress(param);
  }, [connected]);
  const { data, error, reload } = usePortfolio(connected?.address);
  const walletOptions = useWalletOptions();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const visiblePools = applyFilters(data?.pools ?? [], filters);
  const visibleCount = visiblePools.reduce((n, pool) => n + pool.positions.length, 0);
  const signer = canSign(connected, walletOptions);
  const { state: claimState, claim } = useClaim(connected?.address, reload);
  const allPositions = (data?.pools ?? []).flatMap((pool) =>
    pool.positions.filter((p) => p.unclaimed_fees_usd > 0).map((p) => ({ position: p.address, pool: pool.address })),
  );
  const s = data?.summary;
  const today = data?.daily[data.daily.length - 1];
  const lifetime = s ? s.open_pnl_usd + s.closed_pnl_usd : 0;

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Portofolio LP</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-3">
              Posisi DLMM Meteora milik wallet kamu, dengan PnL dari Meteora (deposit, withdraw, dan fee sudah
              diperhitungkan). Keuntungan per hari dicatat engine setiap 15 menit sejak wallet pertama dibuka di sini.
            </p>
          </div>
          {data && (
            <div className="text-right text-xs text-ink-3">
              <div className="font-mono text-ink-2">{shortAddress(data.wallet)}</div>
              diperbarui {fmtDateTime(data.fetched_at)}
            </div>
          )}
        </div>

        {!connected ? (
          <EmptyState />
        ) : (
          <>
            {error && (
              <p className="flex items-center gap-2 rounded-2xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
                <StatusDot severity="critical" /> {error}. Pastikan engine berjalan di {ENGINE_URL}.
              </p>
            )}
            {s && s.out_of_range > 0 && (
              <p className="flex items-center gap-2 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
                <StatusDot severity="warning" /> {s.out_of_range} posisi di luar range dan tidak sedang mengumpulkan fee.
              </p>
            )}

            <ClaimResult state={claimState} />

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
                      onClick={() => void claim("all", allPositions.slice(0, 20))}
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
              <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] backdrop-blur-sm px-4 py-8 text-center text-sm text-ink-3">
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
            {data && data.pools.length > 0 && visiblePools.length === 0 && (
              <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-center text-sm text-ink-3">
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
                renderClaim={(p) => (
                  <ClaimButton
                    label={`Claim fee ${usd.format(p.unclaimed_fees_usd)}`}
                    busyKey={p.address}
                    state={claimState}
                    disabled={!signer || p.unclaimed_fees_usd <= 0}
                    onClick={() => void claim(p.address, [{ position: p.address, pool: pool.address }])}
                  />
                )}
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}
