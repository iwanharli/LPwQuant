"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL, fmtNum, shortAddress, usd } from "../../lib/format";

type Entry = { id: number; ts: number; amount_idr: number | null; amount_usd: number; source: string; note: string | null };
type ChainEvent = { ts: number; usd: number; kind: "deposit" | "withdraw"; signature: string };
export type Capital = {
  usd: number;
  idr: number;
  basis: "manual" | "chain";
  entries: Entry[];
  chain_events: ChainEvent[];
  chain_deposits_usd: number;
  chain_withdrawals_usd: number;
};

const rp = (v: number) => `Rp${new Intl.NumberFormat("id-ID").format(Math.round(Math.abs(v)))}`;
const rpShort = (v: number) => `Rp${fmtNum(Math.abs(v) / 1e6, 1)} jt`;
const dateText = (ms: number) =>
  new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" }).format(ms);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());

/** "36000000" -> "36.000.000" while typing; digits only. */
const withDots = (digits: string) => (digits ? new Intl.NumberFormat("id-ID").format(Number(digits)) : "");

const QUICK = [500_000, 1_000_000, 5_000_000, 10_000_000];

function Row({
  icon,
  tone,
  title,
  sub,
  amount,
  amountSub,
  action,
}: {
  icon: string;
  tone: "in" | "out" | "note";
  title: string;
  sub: string;
  amount: string;
  amountSub?: string;
  action?: React.ReactNode;
}) {
  const tile = tone === "in" ? "bg-sky-400/15 text-sky-300" : tone === "out" ? "bg-orange-400/15 text-orange-300" : "bg-accent/15 text-accent";
  return (
    <li className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.025]">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-base ${tile}`} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{title}</div>
        <div className="truncate text-xs text-ink-3">{sub}</div>
      </div>
      <div className="text-right tabular-nums">
        <div className={`text-sm font-semibold ${tone === "out" ? "text-orange-300" : "text-ink"}`}>{amount}</div>
        {amountSub && <div className="text-[11px] text-ink-3">{amountSub}</div>}
      </div>
      <div className="w-14 text-right">{action}</div>
    </li>
  );
}

function AddForm({ wallet, mode, onDone, onCancel }: { wallet: string; mode: "in" | "out"; onDone: () => void; onCancel: () => void }) {
  const [digits, setDigits] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState(mode === "in" ? "Top-up QRIS" : "Tarik ke rekening");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const amount = Number(digits);
    if (!amount) {
      setError("Isi jumlahnya dulu");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/portfolio/capital`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, amount_idr: mode === "in" ? amount : -amount, date, note: note || undefined }),
      });
      if (!res.ok) throw new Error((await res.json())?.detail ?? `HTTP ${res.status}`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan");
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-black/25 p-4">
      <div className="text-sm font-semibold text-ink">{mode === "in" ? "Catat setoran" : "Catat penarikan"}</div>
      <p className="mt-0.5 text-xs text-ink-3">
        {mode === "in" ? "Jumlah rupiah yang kamu bayar, termasuk biaya top-up." : "Jumlah rupiah yang masuk ke rekening kamu."}
      </p>
      <div className="mt-3 flex items-center rounded-xl border border-line bg-bg/60 px-3 focus-within:border-accent/60">
        <span className="text-lg font-semibold text-ink-3">Rp</span>
        <input
          autoFocus
          inputMode="numeric"
          value={withDots(digits)}
          onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 13))}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder="0"
          aria-label="Jumlah dalam rupiah"
          className="h-12 min-w-0 flex-1 bg-transparent px-2 text-2xl font-semibold tabular-nums text-ink placeholder:text-ink-3 focus:outline-none"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setDigits(String(Number(digits || 0) + q))}
            className="rounded-full border border-line bg-bg/40 px-2.5 py-1 text-xs text-ink-2 hover:border-line-strong hover:text-ink"
          >
            +{q >= 1_000_000 ? `${q / 1_000_000} jt` : `${q / 1000} rb`}
          </button>
        ))}
        {digits && (
          <button type="button" onClick={() => setDigits("")} className="px-2 py-1 text-xs text-ink-3 hover:text-ink">
            kosongkan
          </button>
        )}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr]">
        <input
          type="date"
          value={date}
          max={today()}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Tanggal"
          className="h-10 rounded-xl border border-line bg-bg/60 px-3 text-sm text-ink focus:border-accent/60 focus:outline-none"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Keterangan"
          aria-label="Keterangan"
          className="h-10 rounded-xl border border-line bg-bg/60 px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent/60 focus:outline-none"
        />
      </div>
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-10 rounded-xl px-4 text-sm text-ink-2 hover:text-ink">
          Batal
        </button>
        <button
          type="button"
          disabled={busy || !digits}
          onClick={() => void save()}
          className="h-10 rounded-xl bg-accent px-5 text-sm font-semibold text-[#0b0e13] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Simpan {digits ? rp(Number(digits)) : ""}
        </button>
      </div>
    </div>
  );
}

/** Capital in and out in a dialog: one timeline of what the chain saw and what the user wrote down, and a form. */
function CapitalDialog({
  wallet,
  capital,
  rate,
  initialMode,
  onChange,
  onClose,
}: {
  wallet: string;
  capital: Capital;
  rate: number;
  initialMode: "in" | "out" | null;
  onChange: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"in" | "out" | null>(initialMode);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [showHow, setShowHow] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const remove = async (id: number) => {
    if (!window.confirm("Hapus catatan ini?")) return;
    await fetch(`${ENGINE_URL}/api/portfolio/capital/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, id }),
    });
    onChange();
  };

  type Item = { key: string; ts: number; node: React.ReactNode };
  const items: Item[] = [
    ...capital.entries
      .filter((e) => e.source === "manual")
      .map((e) => ({
        key: `m${e.id}`,
        ts: e.ts,
        node: (
          <Row
            key={`m${e.id}`}
            icon="✎"
            tone={e.amount_usd < 0 ? "out" : "note"}
            title={e.note || (e.amount_usd < 0 ? "Penarikan" : "Setoran")}
            sub={`${dateText(e.ts)} · catatan kamu`}
            amount={`${e.amount_usd < 0 ? "−" : "+"}${e.amount_idr != null ? rp(e.amount_idr) : usd.format(Math.abs(e.amount_usd))}`}
            amountSub={usd.format(Math.abs(e.amount_usd))}
            action={
              <button
                type="button"
                onClick={() => void remove(e.id)}
                className="text-xs text-ink-3 opacity-0 transition hover:text-rose-300 group-hover:opacity-100 focus:opacity-100"
              >
                hapus
              </button>
            }
          />
        ),
      })),
    ...capital.chain_events.map((e) => ({
      key: e.signature,
      ts: e.ts,
      node: (
        <Row
          key={e.signature}
          icon={e.kind === "deposit" ? "↓" : "↑"}
          tone={e.kind === "deposit" ? "in" : "out"}
          title={e.kind === "deposit" ? "Top-up masuk" : "Dikirim ke luar"}
          sub={`${dateText(e.ts)} · terdeteksi di chain`}
          amount={`${e.usd < 0 ? "−" : "+"}${usd.format(Math.abs(e.usd))}`}
          amountSub={`≈ ${rpShort(e.usd * rate)}`}
          action={
            <a href={`https://solscan.io/tx/${e.signature}`} target="_blank" rel="noreferrer" title={shortAddress(e.signature)} className="text-xs text-accent/70 hover:text-accent">
              tx ↗
            </a>
          }
        />
      ),
    })),
  ].sort((a, b) => b.ts - a.ts);
  const shown = showAll ? items : items.slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Modal"
      onClick={(e) => e.stopPropagation()}
      className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-panel shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Modal</h2>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-2xl font-semibold tabular-nums tracking-tight text-ink">{rpShort(capital.idr)}</span>
            <span className="text-sm tabular-nums text-ink-3">{usd.format(capital.usd)} USDC</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${capital.basis === "manual" ? "bg-accent/10 text-accent" : "bg-sky-400/10 text-sky-300"}`}>
              {capital.basis === "manual" ? "dari catatan kamu" : "otomatis dari chain"}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode(mode === "in" ? null : "in")}
            className={`h-9 rounded-xl border px-3.5 text-sm font-medium transition-colors ${mode === "in" ? "border-sky-300/60 bg-sky-400/15 text-sky-200" : "border-line text-ink-2 hover:border-sky-300/40 hover:text-ink"}`}
          >
            + Setoran
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === "out" ? null : "out")}
            className={`h-9 rounded-xl border px-3.5 text-sm font-medium transition-colors ${mode === "out" ? "border-orange-300/60 bg-orange-400/15 text-orange-200" : "border-line text-ink-2 hover:border-orange-300/40 hover:text-ink"}`}
          >
            − Penarikan
          </button>
        </div>
      </div>

      <div className="space-y-3 overflow-y-auto px-3 py-3 sm:px-4">
        {mode && (
          <AddForm
            key={mode}
            wallet={wallet}
            mode={mode}
            onCancel={() => setMode(null)}
            onDone={() => {
              setMode(null);
              onChange();
            }}
          />
        )}

        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-ink-3">Belum ada setoran. Klik &quot;+ Setoran&quot; untuk mencatat modal kamu.</p>
        ) : (
          <ul>{shown.map((i) => i.node)}</ul>
        )}
        {items.length > 5 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="w-full py-1 text-center text-xs text-ink-3 hover:text-ink">
            {showAll ? "Tampilkan lebih sedikit" : `Tampilkan semua (${items.length})`}
          </button>
        )}

        <div className="border-t border-white/[0.05] px-3 pt-3">
          <button type="button" onClick={() => setShowHow((v) => !v)} className="text-xs text-ink-3 hover:text-ink" aria-expanded={showHow}>
            {showHow ? "▾" : "▸"} Bagaimana modal dihitung?
          </button>
          {showHow && (
            <ul className="mt-2 space-y-1.5 pb-1 text-xs leading-5 text-ink-3">
              <li>
                • <span className="text-ink-2">Rupiah</span>: dari catatan kamu, karena top-up QRIS memakai kurs penyedia (kamu bayar Rp36 jt, masuk
                {` ${usd.format(capital.chain_deposits_usd)}`}). Tanpa catatan, setoran di chain dihitung dengan kurs hari ini.
              </li>
              <li>• <span className="text-ink-2">Dolar</span>: USDC yang benar-benar masuk ke wallet, terbaca otomatis dari chain.</li>
              <li>• Setoran di chain setelah catatan terakhir kamu otomatis ditambahkan, jadi top-up baru tidak terlewat.</li>
              <li>• Uang yang kembali dari gacha tidak dihitung sebagai setoran.</li>
            </ul>
          )}
        </div>
      </div>
      <div className="flex justify-end border-t border-line px-5 py-3">
        <button type="button" onClick={onClose} className="h-9 rounded-xl px-4 text-sm text-ink-2 hover:text-ink">
          Tutup
        </button>
      </div>
    </section>
    </div>
  );
}

/** Header buttons: the capital figure opens the history, the two others go straight to the form. */
export default function CapitalButtons({ wallet, capital, rate, onChange }: { wallet: string; capital: Capital; rate: number; onChange: () => void }) {
  const [open, setOpen] = useState<{ mode: "in" | "out" | null } | null>(null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen({ mode: null })}
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/[0.06] bg-panel px-3.5 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          <span className="text-ink-3">Modal</span>
          <span className="font-semibold tabular-nums text-ink">{rpShort(capital.idr)}</span>
        </button>
        <button
          type="button"
          onClick={() => setOpen({ mode: "in" })}
          className="h-9 rounded-xl border border-sky-300/35 bg-sky-400/10 px-3.5 text-sm font-medium text-sky-200 transition-colors hover:bg-sky-400/20"
        >
          + Setoran
        </button>
        <button
          type="button"
          onClick={() => setOpen({ mode: "out" })}
          className="h-9 rounded-xl border border-orange-300/35 bg-orange-400/10 px-3.5 text-sm font-medium text-orange-200 transition-colors hover:bg-orange-400/20"
        >
          − Penarikan
        </button>
      </div>
      {open && (
        <CapitalDialog
          wallet={wallet}
          capital={capital}
          rate={rate}
          initialMode={open.mode}
          onChange={onChange}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
