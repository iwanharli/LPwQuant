"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  CLAIM_URL,
  fmtNum,
  fmtSignedPct,
  fmtTime,
  shortAddress,
  usd,
} from "../../lib/format";
import { canSign, useConnectedWallet, useWalletOptions, useWalletParam } from "../../lib/wallet";
import TopBar from "../top-bar";
import { StatusDot } from "../ui";
import WalletButton from "../wallet-button";
import PortfolioHeader from "./portfolio-header";
import SwapSuggestions from "./swap-suggestions";

const REFRESH_MS = 30_000;
const DUST_USD = 1; // below this a balance is leftovers from swaps and airdropped spam, hidden by default

type WalletToken = {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  amount: number;
  price: number | null;
  value_usd: number | null;
  change_24h: number | null;
  verified: boolean;
  organic_score: number | null;
};
type WalletData = {
  owner: string;
  tokens: WalletToken[];
  total_usd: number;
  fetched_at: number;
};

function useWallet(owner: string | undefined) {
  const [data, setData] = useState<WalletData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    let first = reloadKey > 0;
    const load = async () => {
      try {
        const fresh = first ? "&fresh=1" : "";
        first = false;
        const res = await fetch(`${CLAIM_URL}/wallet?owner=${owner}${fresh}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setData(body as WalletData);
          setError(null);
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error && !/failed to fetch/i.test(err.message)
              ? err.message
              : "Ingestor tidak bisa dihubungi",
          );
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
  }, [owner, reloadKey]);

  return {
    data: data && data.owner === owner ? data : null,
    error,
    reload: () => setReloadKey((k) => k + 1),
  };
}

function Tile({
  label,
  value,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  hint: ReactNode;
}) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-panel px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-sm">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
      <div className="flex min-w-0 items-center gap-2 truncate text-xs font-medium text-ink-3">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-ink">
        {value}
      </div>
      <div className="mt-1 truncate text-xs text-ink-3">{hint}</div>
    </div>
  );
}

function TokenIcon({ t }: { t: WalletToken }) {
  return t.icon ? (
    // eslint-disable-next-line @next/next/no-img-element -- token icons come from many hosts
    <img
      src={t.icon}
      alt=""
      width={32}
      height={32}
      className="h-8 w-8 shrink-0 rounded-full bg-raised object-cover"
    />
  ) : (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-semibold text-ink-3">
      {t.symbol.slice(0, 2)}
    </span>
  );
}

const amountDigits = (v: number) => (v >= 1000 ? 2 : v >= 1 ? 4 : 6);
const priceDigits = (v: number) => (v >= 1 ? 4 : v >= 0.01 ? 6 : 10);

function TokenRow({
  t,
  total,
  muted = false,
}: {
  t: WalletToken;
  total: number;
  muted?: boolean;
}) {
  const share =
    total > 0 && t.value_usd != null ? (t.value_usd / total) * 100 : 0;
  return (
    <tr
      className={`border-b border-line/70 last:border-b-0 hover:bg-raised/30 ${muted ? "opacity-70" : ""}`}
    >
      <td className="px-4 py-2.5">
        <a
          href={`https://solscan.io/token/${t.mint}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3"
          title={t.mint}
        >
          <TokenIcon t={t} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium text-ink">
              {t.symbol}
              {t.verified && (
                <span
                  className="rounded bg-good/15 px-1 text-[10px] font-medium text-good"
                  title="Terverifikasi Jupiter"
                >
                  ✓
                </span>
              )}
            </span>
            <span className="block max-w-56 truncate text-[11px] text-ink-3">
              {t.name}
            </span>
          </span>
        </a>
      </td>
      <td className="px-3 py-2.5 text-right text-ink">
        {fmtNum(t.amount, amountDigits(t.amount))}
      </td>
      <td className="px-3 py-2.5 text-right text-ink-2">
        {t.price == null ? (
          <span className="text-ink-3">–</span>
        ) : (
          `$${fmtNum(t.price, priceDigits(t.price))}`
        )}
      </td>
      <td
        className={`px-3 py-2.5 text-right ${
          t.change_24h == null
            ? "text-ink-3"
            : t.change_24h >= 0
              ? "text-up"
              : "text-down"
        }`}
      >
        {t.change_24h == null ? "–" : fmtSignedPct(t.change_24h, 1)}
      </td>
      <td className="px-3 py-2.5 text-right font-medium text-ink">
        {t.value_usd == null ? (
          <span className="text-ink-3">tanpa harga</span>
        ) : (
          usd.format(t.value_usd)
        )}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-raised">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.min(100, share)}%` }}
            />
          </span>
          <span className="w-10 text-right text-[11px] text-ink-3">
            {share >= 0.1 ? `${share.toFixed(1)}%` : "<0.1%"}
          </span>
        </div>
      </td>
    </tr>
  );
}

export default function WalletPage() {
  const connected = useConnectedWallet();
  useWalletParam(connected);
  const signer = canSign(connected, useWalletOptions());
  const { data, error } = useWallet(connected?.address);
  const [showDust, setShowDust] = useState(false);
  const [query, setQuery] = useState("");

  const tokens = data?.tokens ?? [];
  const priced = tokens.filter((t) => t.value_usd != null);
  const dust = tokens.filter((t) => (t.value_usd ?? 0) < DUST_USD);
  const q = query.trim().toLowerCase();
  const matches = (t: WalletToken) =>
    !q ||
    t.symbol.toLowerCase().includes(q) ||
    t.name.toLowerCase().includes(q) ||
    t.mint.toLowerCase() === q;
  const main = tokens.filter(
    (t) => (t.value_usd ?? 0) >= DUST_USD && matches(t),
  );
  const dustShown = dust.filter(matches);
  // A search reaches into the dust group on its own: hiding a coin the reader is looking for helps nobody.
  const dustOpen = showDust || (q !== "" && dustShown.length > 0);
  const total = data?.total_usd ?? 0;
  const sol = tokens.find(
    (t) => t.mint === "So11111111111111111111111111111111111111112",
  );
  // 24h change of the whole wallet, weighted by value: what the holdings did, not an average of coins.
  const change24h = (() => {
    const w = priced.filter(
      (t) => t.change_24h != null && (t.value_usd ?? 0) > 0,
    );
    const now = w.reduce((n, t) => n + (t.value_usd ?? 0), 0);
    const before = w.reduce(
      (n, t) => n + (t.value_usd ?? 0) / (1 + (t.change_24h ?? 0) / 100),
      0,
    );
    return before > 0 ? (now / before - 1) * 100 : null;
  })();

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PortfolioHeader
          title="Wallet"
          subtitle="Koin di wallet kamu, di luar posisi LP."
          right={
            data && (
              <>
              <div className="text-right text-xs text-ink-3">
                <div className="font-mono text-ink-2">
                  {shortAddress(data.owner)}
                </div>
                diperbarui {fmtTime(data.fetched_at)}
              </div>
              </>
            )
          }
        />

        {!connected ? (
          <div className="grid place-items-center rounded-2xl border border-white/[0.06] bg-panel px-6 py-16 text-center">
            <div className="max-w-md">
              <div className="text-lg font-semibold text-ink">
                Hubungkan wallet untuk melihat koinnya
              </div>
              <p className="mt-2 text-sm text-ink-3">
                Hanya alamat publik yang dibaca.
              </p>
              <div className="mt-5 flex justify-center">
                <WalletButton />
              </div>
            </div>
          </div>
        ) : (
          <>
            {error && (
              <p className="flex items-center gap-2 rounded-2xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2">
                <StatusDot severity="critical" /> {error}
              </p>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Tile
                label="Total nilai wallet"
                value={data ? usd.format(total) : "–"}
                hint="Tanpa posisi LP"
              />
              <Tile
                label="Perubahan 24 jam"
                value={
                  change24h == null ? (
                    "–"
                  ) : (
                    <span className={change24h >= 0 ? "text-up" : "text-down"}>
                      {fmtSignedPct(change24h, 2)}
                    </span>
                  )
                }
                hint="Tertimbang nilai tiap koin"
              />
              <Tile
                label="SOL"
                value={sol ? fmtNum(sol.amount, 4) : "–"}
                hint={
                  sol?.value_usd != null
                    ? `${usd.format(sol.value_usd)} · untuk biaya transaksi`
                    : ""
                }
              />
              <Tile
                label="Jenis koin"
                value={data ? tokens.length : "–"}
                hint={`${tokens.length - dust.length} bernilai ≥ $${DUST_USD} · ${dust.length} debu`}
              />
            </div>

            {connected && data && <SwapSuggestions owner={connected.address} dustCount={dust.length} canSign={signer} />}

            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel shadow-[0_14px_42px_rgba(0,0,0,0.20)] backdrop-blur-sm">
              <div className="flex flex-wrap items-center gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">
                  Koin di wallet
                </h2>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Cari koin…"
                    aria-label="Cari koin"
                    className="h-8 w-40 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none"
                  />
                </div>
              </div>
              {!data ? (
                <p className="px-4 py-8 text-sm text-ink-3">
                  {error ? "Tidak ada data." : "Memuat…"}
                </p>
              ) : main.length === 0 && dustShown.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-ink-3">
                  Tidak ada koin yang cocok.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm tabular-nums">
                    <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                      <tr className="border-b border-line">
                        <th className="px-4 py-2.5 text-left font-medium">
                          Koin
                        </th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          Jumlah
                        </th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          Harga
                        </th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          24 jam
                        </th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          Nilai
                        </th>
                        <th className="px-4 py-2.5 text-left font-medium">
                          Porsi
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {main.map((t) => (
                        <TokenRow key={t.mint} t={t} total={total} />
                      ))}
                    </tbody>
                    {dustShown.length > 0 && (
                      <tbody className="border-t border-line">
                        <tr>
                          <td colSpan={6} className="p-0">
                            <button
                              type="button"
                              onClick={() => setShowDust((v) => !v)}
                              aria-expanded={dustOpen}
                              className="flex w-full items-center gap-2 bg-raised/15 px-4 py-2.5 text-left text-xs font-medium text-ink-2 transition-colors hover:bg-raised/35 hover:text-ink"
                            >
                              <svg
                                viewBox="0 0 20 20"
                                width={14}
                                height={14}
                                className={`text-ink-3 transition-transform ${dustOpen ? "" : "-rotate-90"}`}
                                aria-hidden
                              >
                                <path
                                  d="m5 7.5 5 5 5-5"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth={1.8}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                              Debu ({dustShown.length})
                              <span className="font-normal text-ink-3">
                                · koin di bawah ${DUST_USD}, total{" "}
                                {usd.format(
                                  dustShown.reduce(
                                    (n, t) => n + (t.value_usd ?? 0),
                                    0,
                                  ),
                                )}
                              </span>
                            </button>
                          </td>
                        </tr>
                        {dustOpen &&
                          dustShown.map((t) => (
                            <TokenRow key={t.mint} t={t} total={total} muted />
                          ))}
                      </tbody>
                    )}
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
