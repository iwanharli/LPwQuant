"use client";

import { useEffect, useState } from "react";
import { CLAIM_URL, ENGINE_URL, fmtNum, fmtSignedPct, shortAddress, usdCompact } from "../../lib/format";
import { buildTx, decodeTx, friendlyTxError, logActivity } from "../../lib/tx";
import { signAndSendAll } from "../../lib/wallet";

type Rec = {
  address: string;
  name: string;
  quote: "SOL" | "USDC";
  price: number;
  tvl: number;
  volume_24h: number;
  base_fee_pct: number | null;
  regime: string | null;
  reversal_rate: number | null;
  atr_pct: number;
  change_24h_pct: number | null;
  step_pct: number;
  buy_pct: number;
  sell_pct: number;
  stop_pct: number;
  buy_price: number;
  sell_price: number;
  stop_price: number;
  replay: { cycles: number; stops: number; return_pct: number; holding: boolean; hours: number; candles: number };
};
type Built = {
  side: "buy" | "sell";
  amount: number;
  amount_adjusted: boolean;
  transfer_fee_bps: number;
  active_price: number;
  bins: { bin: number; price: number; amount: number; output: number }[];
  expected_output: number;
  network_fee_lamports: number;
  rent_lamports_estimate: number;
  transaction: string;
};

const REGIME: Record<string, string> = { ranging: "Datar", mixed: "Campuran", trending_up: "Naik pelan" };
const px = (v: number) => (v >= 1 ? fmtNum(v, 4) : v.toExponential(4));
const now = () => Date.now(); // outside components: the purity lint cannot tell handlers from render code

function useRecs() {
  const [data, setData] = useState<Rec[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${ENGINE_URL}/api/limit-order/recommendations`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => !cancelled && b && setData(b.pools as Rec[]))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  return data;
}

function useBalances(owner: string) {
  const [tokens, setTokens] = useState<{ symbol: string; amount: number; mint: string }[]>([]);
  useEffect(() => {
    fetch(`${CLAIM_URL}/wallet?owner=${owner}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => b && setTokens(b.tokens))
      .catch(() => undefined);
  }, [owner]);
  return tokens;
}

type Phase =
  | { phase: "form" }
  | { phase: "building" }
  | { phase: "review"; built: Built; at: number }
  | { phase: "signing" }
  | { phase: "done"; signature: string }
  | { phase: "error"; message: string };

/** Place the buy (or, once it has filled, the sell) at the recommended levels: amount in, review, wallet. */
function PlaceDialog({ rec, owner, side, onClose }: { rec: Rec; owner: string; side: "buy" | "sell"; onClose: () => void }) {
  const balances = useBalances(owner);
  const base = rec.name.split("-")[0];
  const spend = side === "buy" ? rec.quote : base;
  const have = balances.find((t) => t.symbol === spend)?.amount ?? 0;
  const usable = spend === "SOL" ? Math.max(0, have - 0.02) : have; // keep SOL for fees and rent
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<Phase>({ phase: "form" });
  // Buy: a band one step below the price, a little wider than a point so part of a swing fills.
  // Sell: at the target, measured from the current price (the buy already filled somewhere near the buy level).
  const start = side === "buy" ? rec.step_pct : Math.max(0.5, (rec.sell_price / rec.price - 1) * 100);
  const end = start + Math.max(0.6, rec.step_pct * 0.5);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const build = () =>
    buildTx<Built>("/limit-order", { owner, pool: rec.address, amount: Number(amount), start_pct: start, end_pct: end, bins: 4, side });

  const prepare = async () => {
    if (!(Number(amount) > 0)) return;
    setState({ phase: "building" });
    try {
      setState({ phase: "review", built: await build(), at: now() });
    } catch (err) {
      setState({ phase: "error", message: friendlyTxError(err) });
    }
  };
  const confirm = async () => {
    if (state.phase !== "review") return;
    let built = state.built;
    const at = state.at;
    setState({ phase: "signing" });
    try {
      if (now() - at > 45_000) built = await build();
      const [signature] = await signAndSendAll([decodeTx(built.transaction)]);
      setState({ phase: "done", signature });
      logActivity({
        wallet: owner,
        kind: "limit_order_place",
        signatures: [signature],
        pool: rec.address,
        note: `${side === "buy" ? "Beli" : "Jual"} ${rec.name} ${side === "buy" ? `−${fmtNum(start, 1)}%` : `+${fmtNum(start, 1)}%`} (rekomendasi)`,
      });
    } catch (err) {
      setState({ phase: "error", message: friendlyTxError(err) });
    }
  };

  const built = state.phase === "review" ? state.built : null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 px-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_64px_rgba(0,0,0,0.6)]">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">
            {side === "buy" ? `Order beli ${base}` : `Order jual ${base}`} · {rec.name.replace("-", "/")}
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            {side === "buy"
              ? `Terisi kalau harga turun ${fmtNum(start, 1)}–${fmtNum(end, 1)}% dari sekarang. Setelah terisi, pasang jual di +${fmtNum(rec.sell_pct, 1)}% dari harga beli.`
              : `Terisi kalau harga naik ${fmtNum(start, 1)}–${fmtNum(end, 1)}% dari sekarang: target jual rekomendasi.`}
          </p>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm">
          {state.phase === "done" ? (
            <p className="text-ink-2">
              ✅ Order terpasang.{" "}
              <a href={`https://solscan.io/tx/${state.signature}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent hover:underline">
                {shortAddress(state.signature)} ↗
              </a>{" "}
              Pantau di daftar limit order terbuka.
            </p>
          ) : built ? (
            <div className="space-y-1.5 tabular-nums">
              <Line label={side === "buy" ? "Dibayar" : "Dijual"} value={`${fmtNum(built.amount, 4)} ${spend}`} />
              <Line label="Rentang harga" value={`${px(built.bins[0].price)} – ${px(built.bins[built.bins.length - 1].price)}`} />
              <Line label="Kalau terisi penuh" value={`${fmtNum(built.expected_output, built.expected_output >= 1000 ? 0 : 4)} ${side === "buy" ? base : rec.quote}`} />
              <Line label="Deposit sewa (kembali)" value={`${fmtNum(built.rent_lamports_estimate / 1e9, 5)} SOL`} />
              <Line label="Biaya jaringan" value={`≈ ${fmtNum(built.network_fee_lamports / 1e9, 6)} SOL`} />
            </div>
          ) : (
            <>
              <label className="block text-xs text-ink-3">
                Jumlah {spend} {side === "buy" ? "untuk membeli" : "yang dijual"} · saldo {fmtNum(have, 4)}
              </label>
              <div className="flex items-center rounded-xl border border-line bg-bg/60 px-3 focus-within:border-accent/60">
                <input
                  autoFocus
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^\d.]/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && void prepare()}
                  placeholder="0"
                  className="h-11 min-w-0 flex-1 bg-transparent text-xl font-semibold tabular-nums text-ink placeholder:text-ink-3 focus:outline-none"
                />
                <span className="text-sm text-ink-3">{spend}</span>
              </div>
              <div className="flex gap-1.5">
                {[0.1, 0.25, 0.5].map((f) => (
                  <button key={f} type="button" onClick={() => setAmount(String(+(usable * f).toFixed(4)))}
                    className="rounded-full border border-line bg-bg/40 px-2.5 py-1 text-xs text-ink-2 hover:text-ink">
                    {f * 100}% saldo
                  </button>
                ))}
              </div>
              <p className="text-xs leading-5 text-ink-3">
                Saran: pakai sebagian kecil modal per pool. Kalau harga turun sampai cut loss ({fmtNum(rec.stop_pct, 1)}% dari harga beli), batalkan dan
                terima rugi kecil.
              </p>
            </>
          )}
          {state.phase === "error" && <p className="text-xs text-rose-300">{state.message}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <button type="button" onClick={onClose} className="h-9 rounded-xl px-4 text-sm text-ink-2 hover:text-ink">
            {state.phase === "done" ? "Tutup" : "Batal"}
          </button>
          {state.phase !== "done" && (
            <button
              type="button"
              disabled={state.phase === "building" || state.phase === "signing" || (!built && !(Number(amount) > 0))}
              onClick={() => void (built ? confirm() : prepare())}
              className="h-9 rounded-xl bg-accent px-4 text-sm font-semibold text-[#0b0e13] hover:opacity-90 disabled:opacity-40"
            >
              {state.phase === "building" ? "Menyiapkan…" : state.phase === "signing" ? "Setujui di wallet…" : built ? "Lanjut ke wallet" : "Lihat rincian"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-3">{label}</span>
      <span className="text-right text-ink">{value}</span>
    </div>
  );
}

function RecCard({ rec, onPlace, canSign }: { rec: Rec; onPlace: (side: "buy" | "sell") => void; canSign: boolean }) {
  const r = rec.replay;
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-black/20 p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-ink">{rec.name.replace("-", "/")}</div>
          <div className="text-[11px] text-ink-3">
            TVL {usdCompact.format(rec.tvl)} · vol {usdCompact.format(rec.volume_24h)} · fee {fmtNum(rec.base_fee_pct ?? 0, 2)}%
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-line bg-raised/60 px-2 py-0.5 text-[11px] text-ink-2">
          {REGIME[rec.regime ?? ""] ?? "–"} · bolak-balik {fmtNum((rec.reversal_rate ?? 0) * 100, 0)}%
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center tabular-nums">
        <Param label="Beli" pct={`${fmtSignedPct(rec.buy_pct, 1)}`} price={px(rec.buy_price)} cls="text-sky-300" hint="dari harga sekarang" />
        <Param label="Jual" pct={`+${fmtNum(rec.sell_pct, 1)}%`} price={px(rec.sell_price)} cls="text-emerald-300" hint="dari harga beli" />
        <Param label="Cut loss" pct={`${fmtNum(rec.stop_pct, 1)}%`} price={px(rec.stop_price)} cls="text-rose-300" hint="dari harga beli" />
      </div>

      <div
        className="mt-3 rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-ink-3"
        title="Hanya sebagai gambaran. Di 22 order paper engine, hasil uji 48 jam justru berkorelasi −0,27 dengan hasil nyata, jadi urutan rekomendasi tidak lagi memakainya."
      >
        {r.candles < 10
          ? "Data harga 48 jam belum cukup untuk diuji."
          : `Uji 48 jam (bukan dasar pemilihan): ${r.cycles} siklus untung, ${r.stops} cut loss → ${fmtSignedPct(r.return_pct, 1)}${r.holding ? " (masih memegang)" : ""}`}
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" disabled={!canSign} onClick={() => onPlace("buy")}
          title={canSign ? undefined : "Connect lewat extension untuk memasang order"}
          className="h-9 flex-1 rounded-xl bg-sky-400/15 text-sm font-medium text-sky-200 ring-1 ring-inset ring-sky-300/30 hover:bg-sky-400/25 disabled:opacity-40">
          Pasang beli
        </button>
        <button type="button" disabled={!canSign} onClick={() => onPlace("sell")}
          title="Setelah order beli terisi: pasang jual di target"
          className="h-9 rounded-xl px-3 text-sm text-ink-2 ring-1 ring-inset ring-line hover:text-ink disabled:opacity-40">
          Pasang jual
        </button>
        <a href={`https://meteora.ag/dlmm/${rec.address}`} target="_blank" rel="noreferrer"
          className="grid h-9 place-items-center rounded-xl px-3 text-sm text-brand-meteora ring-1 ring-inset ring-brand-meteora/40 hover:bg-brand-meteora/10">
          ↗
        </a>
      </div>
    </div>
  );
}

function Param({ label, pct, price, cls, hint }: { label: string; pct: string; price: string; cls: string; hint: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-2 py-2" title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className={`text-sm font-semibold ${cls}`}>{pct}</div>
      <div className="truncate text-[10px] text-ink-3">{price}</div>
    </div>
  );
}

/** Recommended pools for buy-low / sell-high limit orders, with their levels and a 48-hour replay. */
export default function LimitRecs({ owner, canSign }: { owner: string | null; canSign: boolean }) {
  const recs = useRecs();
  const [placing, setPlacing] = useState<{ rec: Rec; side: "buy" | "sell" } | null>(null);
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel backdrop-blur-sm">
      <div className="border-b border-line bg-raised/20 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Rekomendasi: beli rendah, jual tinggi</h2>
        <p className="mt-0.5 text-xs leading-5 text-ink-3">
          Pool aman, ramai, dan harganya bolak-balik. Jarak order = pergerakan rata-rata 30 menit pool itu (ATR). Diurutkan dari yang harganya paling sering
          berbalik, bukan dari hasil uji 48 jam yang ternyata tidak meramalkan apa pun.
        </p>
      </div>
      {!recs ? (
        <p className="px-4 py-8 text-sm text-ink-3">Memuat…</p>
      ) : recs.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-3">Tidak ada pool yang cocok saat ini: sebagian besar sedang tren atau terlalu sepi.</p>
      ) : (
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {recs.map((r) => (
            <RecCard key={r.address} rec={r} canSign={canSign && !!owner} onPlace={(side) => setPlacing({ rec: r, side })} />
          ))}
        </div>
      )}
      {placing && owner && <PlaceDialog rec={placing.rec} owner={owner} side={placing.side} onClose={() => setPlacing(null)} />}
    </section>
  );
}

