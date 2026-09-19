"use client";

import { useEffect, useState } from "react";
import { CLAIM_URL, ENGINE_URL, fmtNum, fmtSignedPct, shortAddress, usd } from "../../lib/format";
import { buildTx, decodeTx, friendlyTxError, logActivity } from "../../lib/tx";
import { signAndSendAll } from "../../lib/wallet";
import { StatusDot } from "../ui";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RENT_PER_ACCOUNT_SOL = 0.00203928; // rent-exempt deposit of one SPL token account, returned when it is closed
const ORDER_BINS = 8;
const now = () => Date.now(); // outside components: the purity lint cannot tell handlers from render code

type Quote = { out_amount: number; out_usd: number; cost_pct: number; route: string[] } | null;
type LoPool = { address: string; name: string; quote: string; bin_step: number; tvl: number; price: number } | null;
type Suggestion = {
  mint: string;
  symbol: string;
  amount: number;
  value_usd: number;
  change_24h: number | null;
  change_1h: number | null;
  change_6h: number | null;
  verified: boolean;
  organic_score: number | null;
  to_sol: Quote;
  to_usdc: Quote;
  lo_pool_sol: LoPool;
  lo_pool_usdc: LoPool;
};

type Trend = "bullish" | "bearish" | "neutral";
type Range = { start: number; end: number };
type Advice = {
  trend: Trend;
  action: "limit" | "swap";
  target: "SOL" | "USDC";
  pool: LoPool;
  range: Range | null;
  headline: string;
  reasons: string[];
};

/**
 * Short-term trend from Jupiter's 1h and 6h price change. A rule of thumb, not a forecast: in this project's
 * backtests nothing predicted direction better than ~46%, so this only decides which tool fits the moment.
 */
function trendOf(s: Suggestion): Trend {
  const h1 = s.change_1h ?? 0;
  const h6 = s.change_6h ?? 0;
  if (h1 <= -3 || (h1 < 0 && h6 < 0)) return "bearish";
  if (h1 >= 2 && h6 >= 0) return "bullish";
  return "neutral";
}

/** Sell range above the price, wider when the coin is moving fast: a fast riser can reach further, and a narrow
 * range on it would fill at once and give away the move. */
function rangeFor(s: Suggestion, trend: Trend): Range {
  const v = Math.abs(s.change_1h ?? 0);
  if (trend !== "bullish") return { start: 1, end: 4 };
  const start = Math.min(4, Math.max(1, v * 0.15));
  const end = Math.min(30, Math.max(start + 4, start + v * 0.6));
  return { start: Math.round(start * 10) / 10, end: Math.round(end) };
}

function advise(s: Suggestion, lpTokens: Set<string>): Advice {
  const sol = s.to_sol;
  const usdc = s.to_usdc;
  const target: "SOL" | "USDC" = !sol ? "USDC" : !usdc ? "SOL" : usdc.out_usd > sol.out_usd * 1.002 ? "USDC" : "SOL";
  const pool = (target === "SOL" ? s.lo_pool_sol : s.lo_pool_usdc) ?? s.lo_pool_sol ?? s.lo_pool_usdc;
  const trend = trendOf(s);
  const reasons: string[] = [];
  const ch = (v: number | null) => (v == null ? "–" : fmtSignedPct(v, 1));
  const moves = `1 jam ${ch(s.change_1h)} · 6 jam ${ch(s.change_6h)} · 24 jam ${ch(s.change_24h)}`;
  if (lpTokens.has(s.symbol)) reasons.push(`Kemungkinan hasil claim fee dari posisi LP ${s.symbol}.`);
  if (!s.verified) reasons.push("Token belum terverifikasi Jupiter: risiko menahannya lebih besar.");

  if (trend === "bearish" || !pool) {
    return {
      trend,
      action: "swap",
      target,
      pool,
      range: null,
      headline:
        trend === "bearish"
          ? `Sedang turun (${moves}). Tukar sekarang ke ${target} daripada menunggu harga naik.`
          : `Tidak ada pool Meteora untuk limit order. Tukar ke ${target}.`,
      reasons,
    };
  }
  const range = rangeFor(s, trend);
  return {
    trend,
    action: "limit",
    target: pool.quote === "SOL" ? "SOL" : "USDC",
    pool,
    range,
    headline:
      trend === "bullish"
        ? `Sedang naik (${moves}). Jual bertahap lewat limit order +${range.start}% sampai +${range.end}% di atas harga, sambil menerima fee.`
        : `Bergerak datar (${moves}). Limit order tipis +${range.start}% sampai +${range.end}% biasanya cepat terisi dan lebih murah daripada swap.`,
    reasons,
  };
}

const TREND_CHIP = {
  bullish: { label: "Bullish", cls: "border-good/35 bg-good/10 text-good", severity: "good" as const },
  neutral: { label: "Datar", cls: "border-line bg-raised/60 text-ink-2", severity: "info" as const },
  bearish: { label: "Bearish", cls: "border-critical/40 bg-critical/10 text-critical", severity: "critical" as const },
};

type Built = {
  amount: number;
  amount_adjusted: boolean;
  transfer_fee_bps: number;
  order: string;
  pool: string;
  active_price: number;
  bins: { bin: number; price: number; amount: number; output: number }[];
  expected_output: number;
  network_fee_lamports: number;
  rent_lamports_estimate: number;
  transaction: string;
};
type OrderState =
  | { phase: "idle" }
  | { phase: "building"; mint: string }
  | { phase: "review"; mint: string; s: Suggestion; a: Advice; built: Built; at: number }
  | { phase: "signing"; mint: string }
  | { phase: "done"; signature: string; symbol: string }
  | { phase: "error"; message: string };

function OrderReview({ state, onConfirm, onCancel }: { state: Extract<OrderState, { phase: "review" }>; onConfirm: () => void; onCancel: () => void }) {
  const { s, a, built } = state;
  const first = built.bins[0];
  const last = built.bins[built.bins.length - 1];
  const amount = built.amount;
  const feePct = built.transfer_fee_bps / 100;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 px-4 backdrop-blur-sm" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-[#0e1217] shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
      >
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">
            Limit order: jual {s.symbol} ke {a.target}
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">{a.pool?.name.replace("-", "/")} · terisi saat harga naik melewati tiap bin</p>
        </div>
        <div className="space-y-2 px-5 py-4 text-sm tabular-nums">
          <Row
            label="Dijual"
            value={`${fmtNum(amount, 4)} ${s.symbol}`}
            hint={
              built.amount_adjusted
                ? `disesuaikan dari ${fmtNum(s.amount, 4)}: ${s.symbol} punya transfer fee ${fmtNum(feePct, 1)}% yang dibayar dari saldo`
                : feePct > 0
                  ? `+ transfer fee ${fmtNum(feePct, 1)}% dari saldo`
                  : undefined
            }
          />
          <Row label="Harga sekarang" value={fmtNum(built.active_price, 8)} />
          <Row
            label={`Rentang jual (${built.bins.length} bin)`}
            value={`${fmtNum(first.price, 8)} – ${fmtNum(last.price, 8)}`}
            hint={`+${fmtNum((first.price / built.active_price - 1) * 100, 1)}% sampai +${fmtNum((last.price / built.active_price - 1) * 100, 1)}%`}
          />
          <Row label="Hasil kalau terisi penuh" value={`${fmtNum(built.expected_output, a.target === "SOL" ? 5 : 3)} ${a.target}`} hint="ditambah bonus fee" />
          <Row label="Deposit sewa akun" value={`${fmtNum(built.rent_lamports_estimate / 1e9, 5)} SOL`} hint="kembali saat order ditutup" />
          <Row label="Biaya jaringan" value={`≈ ${fmtNum(built.network_fee_lamports / 1e9, 6)} SOL`} />
          <p className="pt-1 text-xs leading-5 text-ink-3">
            Kalau harga tidak naik ke rentang ini, order tidak terisi dan kamu tetap memegang {s.symbol}. Order bisa
            dibatalkan kapan saja di tab Limit order.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <button type="button" onClick={onCancel} className="rounded-lg border border-line px-4 py-2 text-sm text-ink-2 hover:text-ink">
            Batal
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="rounded-lg border border-accent/50 bg-accent/15 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/25"
          >
            Lanjut ke wallet
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-ink-3">{label}</span>
      <span className="text-right text-ink">
        {value}
        {hint && <span className="block text-[11px] text-ink-3">{hint}</span>}
      </span>
    </div>
  );
}

export default function SwapSuggestions({ owner, dustCount, canSign }: { owner: string; dustCount: number; canSign: boolean }) {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [lpTokens, setLpTokens] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<OrderState>({ phase: "idle" });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [sug, pf] = await Promise.all([
          fetch(`${CLAIM_URL}/swap-suggestions?owner=${owner}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
          fetch(`${ENGINE_URL}/api/portfolio?wallet=${owner}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        if (cancelled) return;
        setItems(sug.suggestions as Suggestion[]);
        setFailed(false);
        setLpTokens(new Set(((pf?.pools ?? []) as { token_x: string }[]).map((p) => p.token_x)));
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
  }, [owner]);

  const build = (s: Suggestion, a: Advice) =>
    buildTx<Built>("/limit-order", {
      owner,
      pool: a.pool?.address,
      // A hair under the balance: rounding in the display amount must not ask for more than the wallet holds.
      amount: s.amount * 0.999,
      start_pct: a.range?.start,
      end_pct: a.range?.end,
      bins: ORDER_BINS,
    });

  const prepare = async (s: Suggestion, a: Advice) => {
    setOrder({ phase: "building", mint: s.mint });
    try {
      setOrder({ phase: "review", mint: s.mint, s, a, built: await build(s, a), at: now() });
    } catch (err) {
      setOrder({ phase: "error", message: friendlyTxError(err) });
    }
  };

  const confirm = async () => {
    if (order.phase !== "review") return;
    const { s, a } = order;
    let { built } = order;
    setOrder({ phase: "signing", mint: s.mint });
    try {
      if (now() - order.at > 45_000) built = await build(s, a); // the blockhash inside would be close to expiring
      const [signature] = await signAndSendAll([decodeTx(built.transaction)]);
      setOrder({ phase: "done", signature, symbol: s.symbol });
      logActivity({
        wallet: owner,
        kind: "limit_order_place",
        signatures: [signature],
        pool: a.pool?.address,
        note: `Jual ${built.amount.toPrecision(5)} ${s.symbol} ke ${a.target}, +${a.range?.start}%–${a.range?.end}%`,
      });
    } catch (err) {
      setOrder({ phase: "error", message: friendlyTxError(err) });
    }
  };

  const rentSol = dustCount * RENT_PER_ACCOUNT_SOL;
  if (failed && !items) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97] shadow-[0_14px_42px_rgba(0,0,0,0.20)] backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Saran ke aset utama</h2>
        <span className="text-xs text-ink-3">Bullish: limit order · Bearish: swap sekarang · aset utama SOL dan USDC</span>
      </div>

      {order.phase === "done" && (
        <p className="flex flex-wrap items-center gap-2 border-b border-line bg-good/10 px-4 py-3 text-sm text-ink-2">
          <StatusDot severity="good" /> Limit order {order.symbol} terpasang. Pantau di tab Limit order.
          <a href={`https://solscan.io/tx/${order.signature}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent hover:underline">
            {shortAddress(order.signature)} ↗
          </a>
        </p>
      )}
      {order.phase === "error" && (
        <p className="flex items-center gap-2 border-b border-line bg-critical/10 px-4 py-3 text-sm text-ink-2">
          <StatusDot severity="critical" /> {order.message}
        </p>
      )}

      {!items ? (
        <p className="px-4 py-6 text-sm text-ink-3">Mengambil quote…</p>
      ) : items.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-5 text-sm text-ink-2">
          <StatusDot severity="good" /> Semua koin bernilai ≥ $1 sudah dalam SOL atau USDC.
        </p>
      ) : (
        <div className="divide-y divide-line/70">
          {items.map((s) => {
            const a = advise(s, lpTokens);
            const chip = TREND_CHIP[a.trend];
            const q = a.target === "SOL" ? s.to_sol : s.to_usdc;
            const busy = (order.phase === "building" || order.phase === "signing") && order.mint === s.mint;
            const swapLink = `https://jup.ag/swap/${s.mint}-${a.target === "SOL" ? SOL_MINT : USDC_MINT}`;
            return (
              <div key={s.mint} className="grid gap-4 px-4 py-4 lg:grid-cols-[1.6fr_1fr_auto] lg:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-ink">{s.symbol}</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${chip.cls}`}>
                      <StatusDot severity={chip.severity} />
                      {chip.label}
                    </span>
                    <span className="text-xs tabular-nums text-ink-3">
                      {fmtNum(s.amount, 2)} {s.symbol} · {usd.format(s.value_usd)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm leading-6 text-ink">{a.headline}</p>
                  {a.reasons.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs leading-5 text-ink-3">
                      {a.reasons.map((r) => (
                        <li key={r}>• {r}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-lg border border-line bg-black/20 px-3 py-2 text-xs tabular-nums">
                  <div className="text-ink-3">Kalau swap sekarang ke {a.target}</div>
                  {q ? (
                    <div className="mt-0.5 text-ink">
                      {fmtNum(q.out_amount, a.target === "SOL" ? 4 : 2)} {a.target}{" "}
                      <span className="text-ink-3">≈ {usd.format(q.out_usd)} · biaya {fmtNum(q.cost_pct, 1)}%</span>
                    </div>
                  ) : (
                    <div className="mt-0.5 text-ink-3">Tidak ada rute</div>
                  )}
                </div>
                <div className="flex flex-col items-stretch gap-2">
                  {a.action === "limit" && a.range && (
                    <button
                      type="button"
                      disabled={!canSign || busy}
                      onClick={() => void prepare(s, a)}
                      title={canSign ? undefined : "Connect lewat extension untuk memasang order"}
                      className="whitespace-nowrap rounded-lg border border-accent/45 bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy
                        ? order.phase === "signing"
                          ? "Setujui di wallet…"
                          : "Menyiapkan…"
                        : `Limit order +${a.range.start}%–${a.range.end}% ke ${a.target}`}
                    </button>
                  )}
                  <a
                    href={swapLink}
                    target="_blank"
                    rel="noreferrer"
                    className={`whitespace-nowrap rounded-lg border px-4 py-2 text-center text-sm font-medium ${
                      a.action === "swap"
                        ? "border-accent/45 bg-accent/10 text-accent hover:bg-accent/20"
                        : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
                    }`}
                  >
                    Swap ke {a.target} di Jupiter ↗
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dustCount > 0 && (
        <div className="border-t border-line bg-black/20 px-4 py-3 text-xs leading-5 text-ink-3">
          <span className="font-medium text-ink-2">Debu ({dustCount} koin):</span> nilainya terlalu kecil untuk di-swap.
          Setiap akun token menahan deposit sewa sekitar {RENT_PER_ACCOUNT_SOL} SOL, jadi menutup akun-akun itu (burn lalu
          close, misalnya lewat Sol Incinerator) bisa mengembalikan sekitar <span className="text-ink-2">{fmtNum(rentSol, 3)} SOL</span>.
        </div>
      )}

      {order.phase === "review" && (
        <OrderReview state={order} onConfirm={() => void confirm()} onCancel={() => setOrder({ phase: "idle" })} />
      )}
    </section>
  );
}
