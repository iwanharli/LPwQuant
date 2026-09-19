"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtNum, shortAddress, usd } from "../../lib/format";
import { buildTx, decodeTx, friendlyTxError, logActivity } from "../../lib/tx";
import { signAndSendAll } from "../../lib/wallet";

type Quote = { out_amount: number; out_usd: number; cost_pct: number; route: string[] } | null;
type Built = {
  position: string;
  pool: string;
  receive_x: number;
  receive_y: number;
  fee_x: number;
  fee_y: number;
  transactions: string[];
  network_fee_lamports: number;
  sell: {
    mint: string;
    symbol: string;
    output: string;
    output_symbol: string;
    amount_ui: number;
    value_usd: number;
    before_raw: string;
    slippage_bps: number;
    quote: Quote;
  } | null;
};
type Sell = { transaction: string; amount_raw: string; out_amount: number; route: string[] };

type Phase =
  | { step: "building" }
  | { step: "review"; built: Built; at: number }
  | { step: "closing" }
  | { step: "preparing-sell"; closeSigs: string[] }
  | { step: "selling"; closeSigs: string[] }
  | { step: "done"; closeSigs: string[]; sellSig: string | null; out: number | null }
  | { step: "sell-failed"; closeSigs: string[]; message: string }
  | { step: "error"; message: string };

// A transaction's blockhash expires after ~60-90 s; past this the close is rebuilt before signing.
const REBUILD_AFTER_MS = 40_000;
const amt = (v: number) => fmtNum(v, v < 1 ? 6 : v < 1000 ? 4 : 2);

/**
 * "Tutup + jual": withdraws everything from the position, claims its fees and closes it in one transaction with a
 * priority fee, then, once that has landed, sells exactly the memecoin it brought in through Jupiter. Two wallet
 * prompts, because the sale can only be sized (and simulated by the wallet) after the tokens are in the wallet.
 */
export default function CloseSellButton({
  owner,
  pool,
  position,
  poolName,
  tokenX,
  tokenY,
  valueUsd,
  disabled,
  onDone,
}: {
  owner: string | undefined;
  pool: string;
  position: string;
  poolName: string;
  tokenX: string;
  tokenY: string;
  valueUsd: number;
  disabled: boolean;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [sell, setSell] = useState(true);
  const built = useRef<Built | null>(null);

  const build = useCallback(async () => {
    if (!owner) return null;
    const b = await buildTx<Built>("/close", { owner, pool, position });
    built.current = b;
    return b;
  }, [owner, pool, position]);

  const open = async () => {
    setPhase({ step: "building" });
    try {
      const b = await build();
      if (b) setPhase({ step: "review", built: b, at: Date.now() });
    } catch (err) {
      setPhase({ step: "error", message: friendlyTxError(err) });
    }
  };

  const runSell = async (closeSigs: string[]) => {
    const b = built.current;
    if (!owner || !b?.sell) return;
    setPhase({ step: "preparing-sell", closeSigs });
    try {
      const s = await buildTx<Sell>("/close/sell", {
        owner,
        mint: b.sell.mint,
        output: b.sell.output,
        before_raw: b.sell.before_raw,
        signatures: closeSigs,
        slippage_bps: b.sell.slippage_bps,
      });
      setPhase({ step: "selling", closeSigs });
      const [sig] = await signAndSendAll([decodeTx(s.transaction)]);
      logActivity({ wallet: owner, kind: "swap", signatures: [sig], pool, note: `jual ${b.sell.symbol} → ≈${amt(s.out_amount)} ${b.sell.output_symbol}` });
      setPhase({ step: "done", closeSigs, sellSig: sig, out: s.out_amount });
    } catch (err) {
      setPhase({ step: "sell-failed", closeSigs, message: friendlyTxError(err) });
    }
    setTimeout(onDone, 3000);
  };

  const confirm = async () => {
    if (phase?.step !== "review" || !owner) return;
    let b = phase.built;
    setPhase({ step: "closing" });
    try {
      if (Date.now() - phase.at > REBUILD_AFTER_MS) b = (await build()) ?? b;
      const closeSigs = await signAndSendAll(b.transactions.map(decodeTx));
      logActivity({ wallet: owner, kind: "remove_liquidity", signatures: closeSigs, pool, note: "tutup posisi" });
      if (sell && b.sell) await runSell(closeSigs);
      else {
        setPhase({ step: "done", closeSigs, sellSig: null, out: null });
        setTimeout(onDone, 3000);
      }
    } catch (err) {
      setPhase({ step: "error", message: friendlyTxError(err) });
    }
  };

  const close = useCallback(() => setPhase(null), []);
  const busy = phase?.step === "closing" || phase?.step === "preparing-sell" || phase?.step === "selling";

  useEffect(() => {
    if (!phase || busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, busy, close]);

  return (
    <>
      <button
        type="button"
        disabled={disabled || !!phase}
        onClick={() => void open()}
        className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-400/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Tutup + jual
      </button>
      {phase && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 px-4 backdrop-blur-sm" onClick={() => !busy && close()}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-sell-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-[#0e1217] shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
          >
            <div className="border-b border-line px-5 py-4">
              <h2 id="close-sell-title" className="text-base font-semibold text-ink">
                Tutup posisi {poolName.replace("-", "/")}
              </h2>
              <p className="mt-0.5 text-xs text-ink-3">
                Tarik semua + claim fee + tutup dalam 1 transaksi (priority fee), lalu jual tokennya lewat Jupiter.
              </p>
            </div>
            <Body phase={phase} sell={sell} setSell={setSell} tokenX={tokenX} tokenY={tokenY} valueUsd={valueUsd} />
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
              {phase.step === "sell-failed" && (
                <button
                  type="button"
                  onClick={() => void runSell(phase.closeSigs)}
                  className="rounded-lg border border-accent/50 bg-accent/15 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/25"
                >
                  Coba jual lagi
                </button>
              )}
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="rounded-lg border border-line px-4 py-2 text-sm text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-50"
              >
                {phase.step === "review" || phase.step === "building" ? "Batal" : "Tutup"}
              </button>
              {(phase.step === "review" || phase.step === "building") && (
                <button
                  type="button"
                  onClick={() => void confirm()}
                  disabled={phase.step !== "review"}
                  autoFocus
                  className="rounded-lg border border-rose-400/50 bg-rose-400/15 px-4 py-2 text-sm font-medium text-rose-200 hover:bg-rose-400/25 disabled:cursor-wait disabled:opacity-50"
                >
                  {sell && phase.step === "review" && phase.built.sell ? "Tutup & jual" : "Tutup posisi"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm tabular-nums">
      <span className="text-ink-3">{label}</span>
      <span className="text-right text-ink">{children}</span>
    </div>
  );
}

function Spinner({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-black/25 px-3.5 py-3 text-sm text-ink-2">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-hidden />
      {text}
    </div>
  );
}

function TxLinks({ label, sigs }: { label: string; sigs: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
      {label}
      {sigs.map((s) => (
        <a key={s} href={`https://solscan.io/tx/${s}`} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
          {shortAddress(s)} ↗
        </a>
      ))}
    </div>
  );
}

function Body({
  phase,
  sell,
  setSell,
  tokenX,
  tokenY,
  valueUsd,
}: {
  phase: Phase;
  sell: boolean;
  setSell: (v: boolean) => void;
  tokenX: string;
  tokenY: string;
  valueUsd: number;
}) {
  if (phase.step === "building") return <div className="px-5 py-4"><Spinner text="Menyusun dan mensimulasikan transaksi…" /></div>;
  if (phase.step === "closing") return <div className="px-5 py-4"><Spinner text="Setujui penutupan posisi di wallet…" /></div>;
  if (phase.step === "preparing-sell")
    return (
      <div className="space-y-2 px-5 py-4">
        <TxLinks label="Posisi ditutup:" sigs={phase.closeSigs} />
        <Spinner text="Menunggu konfirmasi, lalu menyusun penjualan dengan jumlah token yang masuk…" />
      </div>
    );
  if (phase.step === "selling")
    return (
      <div className="space-y-2 px-5 py-4">
        <TxLinks label="Posisi ditutup:" sigs={phase.closeSigs} />
        <Spinner text="Setujui penjualan di wallet…" />
      </div>
    );
  if (phase.step === "error") return <p className="px-5 py-4 text-sm text-rose-300">Gagal: {phase.message}</p>;
  if (phase.step === "sell-failed")
    return (
      <div className="space-y-2 px-5 py-4 text-sm">
        <TxLinks label="Posisi sudah ditutup:" sigs={phase.closeSigs} />
        <p className="text-amber-300">Penjualan gagal: {phase.message}</p>
        <p className="text-xs text-ink-3">Token ada di wallet. Coba jual lagi, atau jual dari halaman Wallet.</p>
      </div>
    );
  if (phase.step === "done")
    return (
      <div className="space-y-2 px-5 py-4 text-sm">
        <TxLinks label="Posisi ditutup:" sigs={phase.closeSigs} />
        {phase.sellSig && <TxLinks label={`Terjual ≈ ${amt(phase.out ?? 0)}:`} sigs={[phase.sellSig]} />}
        <p className="text-xs text-ink-3">Hasil bersih ikut diperbarui setelah transaksi terbaca (tekan Refresh di Hasil bersih).</p>
      </div>
    );

  const b = phase.built;
  const s = b.sell;
  return (
    <>
      <div className="space-y-1.5 px-5 py-4">
        <Row label="Ditarik ke wallet">
          <span className="block">{amt(b.receive_x)} {tokenX}</span>
          <span className="block">{amt(b.receive_y)} {tokenY}</span>
          <span className="block text-xs text-ink-3">≈ {usd.format(valueUsd)} · termasuk fee {amt(b.fee_x)} {tokenX} + {amt(b.fee_y)} {tokenY}</span>
        </Row>
        <Row label="Biaya jaringan">≈ {fmtNum(b.network_fee_lamports / 1e9, 6)} SOL <span className="text-xs text-ink-3">(+ sewa posisi kembali)</span></Row>
      </div>
      {s && (
        <div className="border-t border-line bg-black/20 px-5 py-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={sell} onChange={(e) => setSell(e.target.checked)} className="accent-rose-400" />
            Langsung jual {amt(s.amount_ui)} {s.symbol} ke {s.output_symbol}
          </label>
          {sell && (
            <div className="mt-2 space-y-1.5">
              <Row label="Perkiraan hasil">
                {s.quote ? (
                  <>
                    <span className="block">≈ {amt(s.quote.out_amount)} {s.output_symbol}</span>
                    <span className="block text-xs text-ink-3">
                      biaya swap + impact {fmtNum(s.quote.cost_pct, 2)}% · {s.quote.route.join(" → ")}
                    </span>
                  </>
                ) : (
                  <span className="text-ink-3">harga Jupiter belum tersedia</span>
                )}
              </Row>
              <Row label="Slippage maks">{fmtNum(s.slippage_bps / 100, 1)}%</Row>
              <p className="text-[11px] leading-4 text-ink-3">
                Setelah posisi tertutup, jumlah jual diambil dari token yang benar-benar masuk, lalu wallet meminta persetujuan kedua.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
