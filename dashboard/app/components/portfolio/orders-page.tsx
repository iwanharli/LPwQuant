"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, fmtSignedPct, fmtTime, shortAddress, usd } from "../../lib/format";
import { buildTx, decodeTx, friendlyTxError, logActivity } from "../../lib/tx";
import { canSign, signAndSendAll, useConnectedWallet, useWalletOptions, useWalletParam } from "../../lib/wallet";
import TopBar from "../top-bar";
import { StatusDot } from "../ui";
import WalletButton from "../wallet-button";
import { ClosedOrders } from "./closed-history";
import { useUrlState } from "../../lib/url-state";
import PortfolioHeader from "./portfolio-header";
import LimitRecs from "./limit-recs";
import PaperLimitOrders from "./paper-lo";
import PortfolioTabs from "./portfolio-tabs";

const REFRESH_MS = 20_000;
// Outside the component: the purity lint cannot tell an event handler from render code.
const now = () => Date.now();

type OrderBin = { bin: number; price: number; deposit: number; filled: number; status: string };
type Order = {
  address: string;
  is_ask: boolean;
  input_token: string;
  output_token: string;
  lower_price: number;
  upper_price: number;
  input_amount: number;
  input_usd: number;
  output_expected: number;
  filled_pct: number;
  filled_output: number;
  filled_output_usd: number;
  unfilled_input: number;
  unfilled_usd: number;
  bonus_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  opened_at: number | null;
  bins: OrderBin[];
};
type OrderPool = {
  address: string;
  name: string;
  token_x: string;
  token_y: string;
  token_x_icon: string | null;
  price: number;
  orders: Order[];
};
type OrdersData = { wallet: string; pools: OrderPool[]; fetched_at: number };
type CancelBuilt = { order: string; receive_x: number; receive_y: number; network_fee_lamports: number; transaction: string };

function useOrders(wallet: string | undefined) {
  const [data, setData] = useState<OrdersData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    let first = reloadKey > 0;
    const load = async () => {
      try {
        const fresh = first ? "&fresh=true" : "";
        first = false;
        const res = await fetch(`${ENGINE_URL}/api/portfolio/orders?wallet=${wallet}${fresh}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setData(body as OrdersData);
          setError(null);
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
  return { data: data && data.wallet === wallet ? data : null, error, reload: () => setReloadKey((k) => k + 1) };
}

/** Deposit per bin, filled part coloured: the same picture as Meteora's order list. */
function FillBars({ bins }: { bins: OrderBin[] }) {
  const max = Math.max(...bins.map((b) => b.deposit), 1e-12);
  return (
    <div className="flex h-7 w-36 items-end gap-px" aria-hidden>
      {bins.map((b) => {
        const h = Math.max(15, (b.deposit / max) * 100);
        const f = b.deposit > 0 ? Math.min(1, b.filled / b.deposit) : 0;
        return (
          <div key={b.bin} className="relative flex-1 overflow-hidden rounded-t-[2px] bg-[#8b6cf6]/45" style={{ height: `${h}%` }}>
            <div className="absolute inset-x-0 bottom-0 bg-[#3ec6e0]" style={{ height: `${f * 100}%` }} />
          </div>
        );
      })}
    </div>
  );
}

type CancelState =
  | { phase: "idle" }
  | { phase: "building"; order: string }
  | { phase: "review"; order: string; pool: OrderPool; o: Order; built: CancelBuilt; at: number }
  | { phase: "signing"; order: string }
  | { phase: "done"; signature: string }
  | { phase: "error"; message: string };

type OrdersView = "open" | "recs" | "history" | "paper";
const ORDERS_VIEWS = ["open", "recs", "history", "paper"] as const;

export default function OrdersPage() {
  const [view, setView] = useUrlState<OrdersView>("view", "open", ORDERS_VIEWS);
  const connected = useConnectedWallet();
  useWalletParam(connected);
  const walletOptions = useWalletOptions();
  const signer = canSign(connected, walletOptions);
  const { data, error, reload } = useOrders(connected?.address);
  const [cancel, setCancel] = useState<CancelState>({ phase: "idle" });

  const prepareCancel = async (pool: OrderPool, o: Order) => {
    if (!connected) return;
    setCancel({ phase: "building", order: o.address });
    try {
      const built = await buildTx<CancelBuilt>("/limit-order/cancel", { owner: connected.address, pool: pool.address, order: o.address });
      setCancel({ phase: "review", order: o.address, pool, o, built, at: now() });
    } catch (err) {
      setCancel({ phase: "error", message: friendlyTxError(err) });
    }
  };

  const confirmCancel = async () => {
    if (cancel.phase !== "review" || !connected) return;
    const { pool, o } = cancel;
    let { built } = cancel;
    setCancel({ phase: "signing", order: o.address });
    try {
      if (now() - cancel.at > 45_000) {
        built = await buildTx<CancelBuilt>("/limit-order/cancel", { owner: connected.address, pool: pool.address, order: o.address });
      }
      const [signature] = await signAndSendAll([decodeTx(built.transaction)]);
      setCancel({ phase: "done", signature });
      logActivity({
        wallet: connected.address,
        kind: "limit_order_cancel",
        signatures: [signature],
        pool: pool.address,
        note: `${o.filled_pct >= 99.9 ? "Tarik hasil" : "Batalkan"} order ${o.input_token} ke ${o.output_token}`,
      });
      setTimeout(reload, 4000);
    } catch (err) {
      setCancel({ phase: "error", message: friendlyTxError(err) });
    }
  };

  const orders = (data?.pools ?? []).flatMap((p) => p.orders.map((o) => ({ pool: p, o })));
  const totalIn = orders.reduce((n, { o }) => n + o.input_usd, 0);
  const totalFilled = orders.reduce((n, { o }) => n + o.filled_output_usd, 0);
  const totalPnl = orders.reduce((n, { o }) => n + o.pnl_usd, 0);

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PortfolioHeader
          subtitle="Limit order yang masih terbuka."
          right={
            data && (
              <>
              <div className="text-right text-xs text-ink-3">
                <div className="font-mono text-ink-2">{shortAddress(data.wallet)}</div>
                diperbarui {fmtTime(data.fetched_at)}
              </div>
              <button
                type="button"
                onClick={reload}
                className="inline-flex h-9 items-center rounded-lg border border-white/[0.06] bg-panel px-3 text-sm font-medium text-ink-2 hover:border-line-strong hover:text-ink"
              >
                Refresh
              </button>
              </>
            )
          }
        />

        <PortfolioTabs />

        {!connected ? (
          <div className="grid place-items-center rounded-2xl border border-white/[0.06] bg-panel px-6 py-16 text-center">
            <div className="text-lg font-semibold text-ink">Hubungkan wallet untuk melihat limit order</div>
            <div className="mt-5">
              <WalletButton />
            </div>
          </div>
        ) : (
          <>
            {error && (
              <p className="flex items-center gap-2 rounded-2xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2">
                <StatusDot severity="critical" /> {error}
              </p>
            )}
            {cancel.phase === "done" && (
              <p className="flex flex-wrap items-center gap-2 rounded-2xl border border-good/30 bg-good/10 px-4 py-3 text-sm text-ink-2">
                <StatusDot severity="good" /> Order dibatalkan, token sudah kembali ke wallet.
                <a href={`https://solscan.io/tx/${cancel.signature}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent hover:underline">
                  {shortAddress(cancel.signature)} ↗
                </a>
              </p>
            )}
            {cancel.phase === "error" && (
              <p className="flex items-center gap-2 rounded-2xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2">
                <StatusDot severity="critical" /> Gagal: {cancel.message}
              </p>
            )}

            <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Tampilan limit order">
              {(
                [
                  { value: "open", label: `Order terbuka${orders.length ? ` (${orders.length})` : ""}` },
                  { value: "recs", label: "Rekomendasi" },
                  { value: "history", label: "Riwayat" },
                  { value: "paper", label: "Uji engine" },
                ] as const
              ).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="tab"
                  aria-selected={view === o.value}
                  onClick={() => setView(o.value)}
                  className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                    view === o.value ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {view === "open" && (
            <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {[
                { label: "Order terbuka", value: String(orders.length), hint: `${orders.filter(({ o }) => o.filled_pct >= 99.9).length} terisi penuh` },
                { label: "Nilai dipasang", value: usd.format(totalIn), hint: `${usd.format(totalFilled)} sudah terisi` },
                {
                  label: "PnL order",
                  value: <span className={totalPnl >= 0 ? "text-up" : "text-down"}>{`${totalPnl >= 0 ? "+" : "−"}${usd.format(Math.abs(totalPnl))}`}</span>,
                  hint: "Termasuk bonus fee, belum ditarik",
                },
              ].map((t) => (
                <div key={t.label} className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3.5 backdrop-blur-sm">
                  <div className="text-xs font-medium text-ink-3">{t.label}</div>
                  <div className="mt-2 text-2xl font-semibold tabular-nums text-ink">{t.value}</div>
                  <div className="mt-1 text-xs text-ink-3">{t.hint}</div>
                </div>
              ))}
            </div>

            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
              <div className="border-b border-line bg-white/[0.02] px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">Limit order terbuka</h2>
              </div>
              {!data ? (
                <p className="px-4 py-8 text-sm text-ink-3">Memuat…</p>
              ) : orders.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-ink-3">
                  Tidak ada limit order terbuka. Buat dari kartu saran swap di tab Wallet.
                </p>
              ) : (
                <div className="divide-y divide-line/70">
                  {orders.map(({ pool, o }) => {
                    const busy = (cancel.phase === "building" || cancel.phase === "signing") && cancel.order === o.address;
                    return (
                      <div key={o.address} className="grid gap-4 px-4 py-4 text-sm tabular-nums lg:grid-cols-[1.4fr_1fr_1.3fr_1fr_1fr_auto] lg:items-center">
                        <div>
                          <div className="font-medium">
                            <span className={o.is_ask ? "text-down" : "text-up"}>{o.is_ask ? "Jual" : "Beli"} {o.input_token}</span>
                            <span className="text-ink"> ke {o.output_token}</span>
                          </div>
                          <div className="mt-0.5 text-xs text-ink-3">
                            {fmtNum(o.input_amount, 2)} {o.input_token} → {fmtNum(o.output_expected, 4)} {o.output_token}
                          </div>
                          <div className="text-[11px] text-ink-3">
                            {pool.name.replace("-", "/")} · {o.opened_at ? fmtDateTime(o.opened_at) : ""}
                          </div>
                        </div>
                        <div>
                          <div className="text-ink">
                            {fmtNum(o.lower_price, 6)} – {fmtNum(o.upper_price, 6)}
                          </div>
                          <div className="text-[11px] text-ink-3">
                            harga sekarang {fmtNum(pool.price, 6)}
                            {pool.price < o.lower_price
                              ? ` · naik ${fmtSignedPct((o.lower_price / pool.price - 1) * 100, 1)} lagi untuk mulai terisi`
                              : pool.price <= o.upper_price
                                ? " · di dalam rentang, sedang terisi"
                                : " · sudah melewati rentang"}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div>
                            <div className="text-ink">{usd.format(o.input_usd)}</div>
                            <div className="text-[11px] text-ink-3">terisi {fmtNum(o.filled_pct, 1)}%</div>
                          </div>
                          <FillBars bins={o.bins} />
                        </div>
                        <div>
                          <div className="text-ink">
                            {fmtNum(o.filled_output, 4)} {o.output_token}
                          </div>
                          <div className="text-[11px] text-ink-3">+ bonus fee {usd.format(o.bonus_usd)}</div>
                        </div>
                        <div className={o.pnl_usd >= 0 ? "text-up" : "text-down"}>
                          <div className="font-medium">{`${o.pnl_usd >= 0 ? "+" : "−"}${usd.format(Math.abs(o.pnl_usd))}`}</div>
                          <div className="text-[11px]">{fmtSignedPct(o.pnl_pct, 2)}</div>
                        </div>
                        <button
                          type="button"
                          disabled={!signer || busy}
                          onClick={() => void prepareCancel(pool, o)}
                          title={signer ? "Batalkan order dan tarik semua token ke wallet" : "Connect lewat extension untuk membatalkan"}
                          className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-1.5 text-xs font-medium text-critical hover:bg-critical/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {busy ? (cancel.phase === "signing" ? "Setujui di wallet…" : "Menyiapkan…") : o.filled_pct >= 99.9 ? "Tarik hasil" : "Cancel"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            </>
            )}

            {view === "recs" && <LimitRecs owner={connected.address} canSign={signer} />}

            {view === "history" && <ClosedOrders wallet={connected.address} />}

            {view === "paper" && <PaperLimitOrders />}
          </>
        )}

        {cancel.phase === "review" && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 px-4 backdrop-blur-sm" onClick={() => setCancel({ phase: "idle" })}>
            <div
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.06] bg-panel shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
            >
              <div className="border-b border-line px-5 py-4">
                <h2 className="text-base font-semibold text-ink">{cancel.o.filled_pct >= 99.9 ? "Tarik hasil order" : "Batalkan limit order"}</h2>
                <p className="mt-0.5 text-xs text-ink-3">Semua token di order ini ditarik ke wallet, lalu ordernya ditutup.</p>
              </div>
              <div className="space-y-2 px-5 py-4 text-sm tabular-nums">
                <div className="flex justify-between">
                  <span className="text-ink-3">Kembali ke wallet</span>
                  <span className="text-right text-ink">
                    <span className="block">+{fmtNum(cancel.built.receive_x, 4)} {cancel.pool.token_x}</span>
                    <span className="block">+{fmtNum(cancel.built.receive_y, 6)} {cancel.pool.token_y}</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Biaya jaringan</span>
                  <span className="text-ink-2">≈ {fmtNum(cancel.built.network_fee_lamports / 1e9, 6)} SOL</span>
                </div>
                <p className="pt-1 text-xs text-ink-3">
                  Jumlah token bisa sedikit lebih kecil dari angka Meteora kalau token itu punya transfer fee (GP sekitar 3%).
                </p>
              </div>
              <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
                <button type="button" onClick={() => setCancel({ phase: "idle" })} className="rounded-lg border border-line px-4 py-2 text-sm text-ink-2 hover:text-ink">
                  Batal
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={() => void confirmCancel()}
                  className="rounded-lg border border-accent/50 bg-accent/15 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/25"
                >
                  Lanjut ke wallet
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
