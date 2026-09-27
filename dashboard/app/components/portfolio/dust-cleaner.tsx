"use client";

import { useMemo, useState } from "react";
import { CLAIM_URL, fmtNum, shortAddress, usd } from "../../lib/format";
import { buildTx, decodeTx, friendlyTxError } from "../../lib/tx";
import { signAndSendAll } from "../../lib/wallet";

type Account = {
  account: string;
  mint: string;
  program: "token" | "token-2022";
  amount: number;
  rent_sol: number;
  frozen: boolean;
  withheld: boolean;
  wrapped_sol: boolean;
  protected: boolean;
  symbol: string | null;
  value_usd: number | null;
};
type Built = { transactions: string[]; closing: number; reclaim_sol: number; network_fee_sol: number; skipped: { account: string; reason: string }[] };

const DUST_USD = 1;

/** Selected by default: worthless or unpriced leftovers that can be closed. */
const defaultPick = (a: Account) => !a.frozen && !a.protected && (a.value_usd ?? 0) < DUST_USD;

function status(a: Account): { text: string; cls: string } | null {
  if (a.frozen) return { text: "dibekukan", cls: "bg-rose-500/15 text-rose-300" };
  if (a.protected) return { text: "stablecoin", cls: "bg-white/[0.06] text-ink-3" };
  if (a.wrapped_sol) return { text: "wSOL: saldo kembali jadi SOL", cls: "bg-emerald-500/10 text-emerald-300" };
  if (a.amount === 0) return { text: "kosong", cls: "bg-white/[0.06] text-ink-3" };
  if (a.withheld) return { text: "ada fee tertahan", cls: "bg-amber-400/10 text-amber-300" };
  return null;
}

export default function DustCleaner({ owner, canSign, onDone }: { owner: string; canSign: boolean; onDone: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"load" | "build" | "sign" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = async () => {
    setBusy("load");
    setMsg(null);
    try {
      const res = await fetch(`${CLAIM_URL}/dust?owner=${owner}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
      const list = (body.accounts as Account[]).sort((a, b) => (a.value_usd ?? 0) - (b.value_usd ?? 0));
      setAccounts(list);
      setPicked(new Set(list.filter(defaultPick).map((a) => a.account)));
    } catch (e) {
      setMsg({ ok: false, text: friendlyTxError(e) });
    } finally {
      setBusy(null);
    }
  };

  const chosen = useMemo(() => (accounts ?? []).filter((a) => picked.has(a.account)), [accounts, picked]);
  const rent = chosen.reduce((s, a) => s + a.rent_sol, 0);
  const burnedUsd = chosen.reduce((s, a) => s + (a.wrapped_sol ? 0 : (a.value_usd ?? 0)), 0);
  const closable = (accounts ?? []).filter((a) => !a.frozen && !a.protected);
  const totalRent = closable.reduce((s, a) => s + a.rent_sol, 0);
  const visible = (accounts ?? []).filter((a) => showAll || (a.value_usd ?? 0) < DUST_USD || picked.has(a.account));

  const toggle = (a: Account) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(a.account)) n.delete(a.account);
      else n.add(a.account);
      return n;
    });

  const run = async () => {
    if (!chosen.length) return;
    if (burnedUsd >= DUST_USD && !window.confirm(`Token senilai ${usd.format(burnedUsd)} akan DIBAKAR (hilang). Lanjutkan?`)) return;
    setMsg(null);
    try {
      setBusy("build");
      const b = await buildTx<Built>("/dust/close", { owner, accounts: chosen.map((a) => a.account) });
      setBusy("sign");
      const sigs = await signAndSendAll(b.transactions.map(decodeTx));
      setMsg({
        ok: true,
        text: `${b.closing} akun ditutup dalam ${sigs.length} transaksi: ±${fmtNum(b.reclaim_sol, 4)} SOL kembali ke wallet${
          b.skipped.length ? ` · ${b.skipped.length} dilewati (${b.skipped[0].reason})` : ""
        }.`,
      });
      onDone();
      setTimeout(load, 4000);
    } catch (e) {
      setMsg({ ok: false, text: friendlyTxError(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div>
          <h2 className="text-base font-semibold text-ink">Bersihkan debu → SOL</h2>
          <p className="text-xs text-ink-3">
            Setiap token di wallet punya akun yang menahan ±0,002 SOL. Sisa token dibakar, akunnya ditutup, dan SOL-nya kembali ke wallet.
          </p>
        </div>
        {!accounts && (
          <button type="button" onClick={load} disabled={busy !== null} className="btn-accent rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50">
            {busy === "load" ? "Membaca akun…" : "Cek akun token"}
          </button>
        )}
      </div>

      {accounts && (
        <>
          <div className="grid grid-cols-2 gap-px border-y border-line bg-line/40 sm:grid-cols-4">
            {[
              ["Akun token", String(accounts.length), `${closable.length} bisa ditutup`],
              ["Rent bisa diambil", `${fmtNum(totalRent, 4)} SOL`, "kalau semua ditutup"],
              ["Dipilih", String(chosen.length), `±${fmtNum(rent, 4)} SOL kembali`],
              ["Token dibakar", usd.format(burnedUsd), burnedUsd >= DUST_USD ? "periksa lagi pilihannya" : "nilainya debu"],
            ].map(([l, v, h], i) => (
              <div key={l} className="bg-panel px-4 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{l}</div>
                <div className={`mt-0.5 text-lg font-semibold tabular-nums ${i === 3 && burnedUsd >= DUST_USD ? "text-amber-300" : "text-ink"}`}>{v}</div>
                <div className="text-[11px] text-ink-3">{h}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-xs text-ink-3">
            <button type="button" onClick={() => setPicked(new Set(accounts.filter(defaultPick).map((a) => a.account)))} className="hover:text-ink">
              Pilih debu saja
            </button>
            <button type="button" onClick={() => setPicked(new Set())} className="hover:text-ink">
              Kosongkan pilihan
            </button>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Tampilkan juga token bernilai ≥ ${DUST_USD}
            </label>
            <button type="button" onClick={load} disabled={busy !== null} className="ml-auto hover:text-ink disabled:opacity-50">
              {busy === "load" ? "Membaca…" : "Muat ulang"}
            </button>
          </div>

          <div className="max-h-[420px] overflow-auto border-t border-line">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 bg-panel text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <tr>
                  <th className="w-10 px-4 py-2" />
                  <th className="px-2 py-2 font-medium">Token</th>
                  <th className="px-2 py-2 text-right font-medium">Saldo</th>
                  <th className="px-2 py-2 text-right font-medium">Nilai</th>
                  <th className="px-2 py-2 text-right font-medium">Rent</th>
                  <th className="px-4 py-2 font-medium">Catatan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {visible.map((a) => {
                  const st = status(a);
                  const locked = a.frozen || a.protected;
                  return (
                    <tr key={a.account} className={locked ? "opacity-50" : "cursor-pointer hover:bg-white/[0.03]"} onClick={() => !locked && toggle(a)}>
                      <td className="px-4 py-2">
                        <input type="checkbox" checked={picked.has(a.account)} disabled={locked} readOnly aria-label={`Pilih ${a.symbol ?? a.mint}`} />
                      </td>
                      <td className="px-2 py-2">
                        <span className="font-medium text-ink">{a.symbol ?? shortAddress(a.mint)}</span>
                        {a.program === "token-2022" && <span className="ml-1.5 text-[10px] text-ink-3">T22</span>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-ink-2">{a.amount === 0 ? "0" : fmtNum(a.amount, a.amount < 1 ? 6 : 2)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-ink-2">{a.value_usd == null ? <span className="text-ink-3">tanpa harga</span> : usd.format(a.value_usd)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-ink-2">{fmtNum(a.rent_sol, 4)}</td>
                      <td className="px-4 py-2">{st && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${st.cls}`}>{st.text}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
            <p className="max-w-xl text-xs leading-5 text-ink-3">
              Token yang dipilih <b className="text-ink-2">dibakar dan tidak bisa kembali</b>. Wallet-mu akan menampilkan perubahan saldo sebelum kamu setujui
              {chosen.length > 6 ? `, dalam ${Math.ceil(chosen.length / 6)} transaksi` : ""}. Akun yang dibekukan pembuat token tidak bisa ditutup.
            </p>
            <button
              type="button"
              onClick={run}
              disabled={!canSign || !chosen.length || busy !== null}
              title={canSign ? undefined : "Hubungkan wallet yang bisa menandatangani"}
              className="btn-accent rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-40"
            >
              {busy === "build" ? "Menyusun…" : busy === "sign" ? "Setujui di wallet…" : `Bersihkan ${chosen.length} akun · +${fmtNum(rent, 3)} SOL`}
            </button>
          </div>
        </>
      )}
      {msg && <p className={`border-t border-line px-4 py-2.5 text-sm ${msg.ok ? "text-emerald-300" : "text-rose-300"}`}>{msg.text}</p>}
    </section>
  );
}
