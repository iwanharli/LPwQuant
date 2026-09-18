"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, fmtSignedPct, shortAddress, usd } from "../../lib/format";
import { useConnectedWallet } from "../../lib/wallet";
import TopBar from "../top-bar";
import { StatusDot } from "../ui";
import WalletButton from "../wallet-button";
import DailyPnlChart, { type DailyPnl } from "./daily-pnl-chart";

const REFRESH_MS = 60_000;

type Position = {
  address: string;
  lower_bin: number;
  upper_bin: number;
  active_bin: number | null;
  min_price: number;
  max_price: number;
  active_price: number | null;
  out_of_range: boolean | null;
  created_at: number | null;
  value_usd: number;
  value_sol: number;
  amount_x: number;
  amount_y: number;
  unclaimed_fee_x: number;
  unclaimed_fee_y: number;
  unclaimed_fees_usd: number;
  deposit_usd: number;
  fees_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  pnl_sol: number;
  pnl_sol_pct: number;
};

type Pool = {
  address: string;
  name: string;
  token_x: string;
  token_y: string;
  token_x_icon: string | null;
  token_y_icon: string | null;
  bin_step: number;
  base_fee: number;
  value_usd: number;
  value_sol: number;
  unclaimed_fees_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  pnl_sol: number;
  out_of_range: boolean;
  open_positions: number;
  fee_tvl_24h: number;
  positions: Position[];
};

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

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/portfolio?wallet=${wallet}`);
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
  }, [wallet]);

  // A different wallet: do not show the previous one's numbers while the new one loads.
  return { data: loadedFor === wallet ? data : null, error };
}

const signedUsd = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const signedSol = (v: number) => `${v >= 0 ? "+" : "−"}${fmtNum(Math.abs(v), 4)} SOL`;
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink-2");

function Tile({ label, value, hint }: { label: ReactNode; value: ReactNode; hint: ReactNode }) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-2xl border border-line bg-panel/90 px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
      <div className="flex min-w-0 items-center gap-2 truncate text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-ink">{value}</div>
      <div className="mt-1 truncate text-xs text-ink-3">{hint}</div>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/90 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function TokenPair({ pool }: { pool: Pool }) {
  return (
    <span className="flex shrink-0 -space-x-2">
      {[pool.token_x_icon, pool.token_y_icon].map((src, i) =>
        src ? (
          // eslint-disable-next-line @next/next/no-img-element -- token icons come from many hosts
          <img key={i} src={src} alt="" width={26} height={26} className="h-[26px] w-[26px] rounded-full border-2 border-panel bg-raised" />
        ) : (
          <span key={i} className="h-[26px] w-[26px] rounded-full border-2 border-panel bg-raised" />
        ),
      )}
    </span>
  );
}

/** Where the active bin sits inside the position's bins: the reader's first question about any LP position. */
function RangeBar({ p }: { p: Position }) {
  const span = Math.max(1, p.upper_bin - p.lower_bin);
  const active = p.active_bin;
  const below = active != null && active < p.lower_bin;
  const above = active != null && active > p.upper_bin;
  const pct = active == null ? null : Math.min(100, Math.max(0, ((active - p.lower_bin) / span) * 100));
  const oor = below || above || p.out_of_range === true;
  return (
    <div className="min-w-44">
      <div className="relative h-2 rounded-full bg-raised">
        <div className={`absolute inset-y-0 left-0 right-0 rounded-full ${oor ? "bg-down/25" : "bg-accent/25"}`} />
        {pct != null && (
          <span
            className={`absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ${oor ? "bg-down" : "bg-accent"}`}
            style={{ left: `${pct}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-ink-3">
        <span>{fmtNum(p.min_price, p.min_price < 1 ? 8 : 4)}</span>
        <span>{fmtNum(p.max_price, p.max_price < 1 ? 8 : 4)}</span>
      </div>
    </div>
  );
}

function StatusChip({ p }: { p: Position }) {
  const below = p.active_bin != null && p.active_bin < p.lower_bin;
  const above = p.active_bin != null && p.active_bin > p.upper_bin;
  const oor = below || above || p.out_of_range === true;
  const label = !oor ? "In range" : below ? "Di bawah range" : above ? "Di atas range" : "Out of range";
  const hint = !oor
    ? "Harga di dalam range: posisi mengumpulkan fee"
    : below
      ? "Harga turun di bawah range: posisi penuh token, tidak mengumpulkan fee"
      : "Harga naik di atas range: posisi penuh SOL/quote, tidak mengumpulkan fee";
  return (
    <span
      title={hint}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-raised/70 px-2 py-0.5 text-xs font-medium text-ink"
    >
      <StatusDot severity={oor ? "critical" : "good"} />
      {label}
    </span>
  );
}

function PoolCard({ pool }: { pool: Pool }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel/90 shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-raised/20 px-4 py-3">
        <TokenPair pool={pool} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            {pool.name}
            <span className="font-normal text-ink-3">bin step {pool.bin_step}</span>
          </div>
          <div className="text-xs text-ink-3">
            {pool.open_positions} posisi · fee/TVL 24j {fmtNum(pool.fee_tvl_24h, 2)}%
          </div>
        </div>
        <div className="ml-auto flex items-center gap-5 text-right tabular-nums">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-3">Nilai</div>
            <div className="text-sm font-semibold text-ink">{usd.format(pool.value_usd)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-3">PnL</div>
            <div className={`text-sm font-semibold ${tone(pool.pnl_usd)}`}>
              {signedUsd(pool.pnl_usd)} <span className="text-xs font-normal">({fmtSignedPct(pool.pnl_pct, 1)})</span>
            </div>
          </div>
          <a
            href={`https://app.meteora.ag/dlmm/${pool.address}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-brand-meteora/45 px-2.5 py-1.5 text-xs font-medium text-brand-meteora hover:bg-brand-meteora/10"
          >
            Meteora ↗
          </a>
        </div>
      </div>
      {pool.positions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-3">Detail posisi belum tersedia dari Meteora.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm tabular-nums">
            <thead className="text-[11px] uppercase tracking-wider text-ink-3">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 text-left font-medium">Posisi</th>
                <th className="px-3 py-2.5 text-right font-medium">Nilai</th>
                <th className="px-3 py-2.5 text-left font-medium">Range harga</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Fee belum di-claim</th>
                <th className="px-4 py-2.5 text-right font-medium">PnL</th>
              </tr>
            </thead>
            <tbody>
              {pool.positions.map((p) => (
                <tr key={p.address} className="border-b border-line/70 last:border-b-0 hover:bg-raised/30">
                  <td className="px-4 py-3 align-top">
                    <div className="font-mono text-xs text-ink-2">{shortAddress(p.address)}</div>
                    <div className="text-[11px] text-ink-3">
                      {p.created_at ? `dibuka ${fmtDateTime(p.created_at)}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    <div className="font-medium text-ink">{usd.format(p.value_usd)}</div>
                    <div className="text-[11px] text-ink-3">
                      {fmtNum(p.amount_x, 2)} {pool.token_x} · {fmtNum(p.amount_y, 4)} {pool.token_y}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <RangeBar p={p} />
                  </td>
                  <td className="px-3 py-3 align-top">
                    <StatusChip p={p} />
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    <div className="font-medium text-ink">{usd.format(p.unclaimed_fees_usd)}</div>
                    <div className="text-[11px] text-ink-3">
                      {fmtNum(p.unclaimed_fee_x, 2)} {pool.token_x} · {fmtNum(p.unclaimed_fee_y, 4)} {pool.token_y}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right align-top">
                    <div className={`font-medium ${tone(p.pnl_usd)}`}>
                      {signedUsd(p.pnl_usd)} ({fmtSignedPct(p.pnl_pct, 1)})
                    </div>
                    <div className={`text-[11px] ${tone(p.pnl_sol)}`}>
                      {signedSol(p.pnl_sol)} ({fmtSignedPct(p.pnl_sol_pct, 1)})
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center rounded-2xl border border-line bg-panel/80 px-6 py-16 text-center shadow-[0_14px_42px_rgba(0,0,0,0.20)]">
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
  const { data, error } = usePortfolio(connected?.address);
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
                hint="Sudah termasuk di PnL"
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
              <p className="rounded-2xl border border-line bg-panel/80 px-4 py-8 text-center text-sm text-ink-3">
                Tidak ada posisi DLMM terbuka di wallet ini.
              </p>
            )}
            {data?.pools.map((pool) => <PoolCard key={pool.address} pool={pool} />)}
          </>
        )}
      </main>
    </div>
  );
}
