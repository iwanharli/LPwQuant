"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { shortAddress } from "../lib/format";
import {
  connectWallet,
  disconnectWallet,
  isWalletAddress,
  useConnectedWallet,
  useWalletOptions,
  watchAddress,
} from "../lib/wallet";

function WalletGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden>
      <path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2 2 0 0 0 2 2h14V8H6.5A2.5 2.5 0 0 1 4 7.5Zm12.5 6h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Connect wallet in the top bar: lists the Solana wallets installed in this browser (Jupiter first), or takes a
 * pasted address. Read-only: only the public address is requested, nothing is ever signed. */
export default function WalletButton() {
  const connected = useConnectedWallet();
  const options = useWalletOptions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const connect = async (name: string) => {
    const option = options.find((o) => o.name === name);
    if (!option) return;
    setBusy(name);
    setError(null);
    try {
      await connectWallet(option);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error && /reject|cancel/i.test(err.message) ? "Koneksi dibatalkan" : "Gagal terhubung");
    } finally {
      setBusy(null);
    }
  };

  const watch = () => {
    if (!isWalletAddress(typed)) {
      setError("Alamat wallet Solana tidak valid");
      return;
    }
    watchAddress(typed);
    setTyped("");
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium shadow-sm shadow-black/20 transition-colors ${
          connected
            ? "border-white/[0.06] bg-panel/80 text-ink hover:border-line-strong"
            : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
        }`}
      >
        <WalletGlyph />
        {connected ? <span className="tabular-nums">{shortAddress(connected.address)}</span> : "Connect wallet"}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-40 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-white/[0.06] bg-panel shadow-[0_18px_48px_rgba(0,0,0,0.45)]">
          {connected ? (
            <div className="p-3">
              <div className="text-xs text-ink-3">{connected.wallet ? `Terhubung lewat ${connected.wallet}` : "Dipantau (tanpa extension)"}</div>
              <div className="mt-1 break-all font-mono text-xs text-ink-2">{connected.address}</div>
              <div className="mt-3 grid gap-2">
                <Link
                  href="/portfolio"
                  onClick={() => setOpen(false)}
                  className="rounded-xl border border-white/[0.08] bg-raised/50 px-3 py-2 text-sm text-ink hover:border-line-strong"
                >
                  Buka Portofolio LP
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    void disconnectWallet();
                    setOpen(false);
                  }}
                  className="rounded-xl border border-white/[0.08] px-3 py-2 text-left text-sm text-ink-2 hover:border-critical/40 hover:text-ink"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div className="p-3">
              <div className="text-sm font-semibold text-ink">Hubungkan wallet</div>
              <p className="mt-0.5 text-xs leading-5 text-ink-3">
                Hanya membaca alamat publik untuk memantau posisi LP. Tidak ada transaksi yang diminta.
              </p>
              <div className="mt-3 grid gap-1.5">
                {options.length === 0 && (
                  <p className="rounded-xl border border-white/[0.08] bg-bg/40 px-3 py-2 text-xs text-ink-3">
                    Tidak ada wallet Solana terdeteksi di browser ini. Pasang Jupiter Wallet, atau tempel alamat di bawah.
                  </p>
                )}
                {options.map((o) => (
                  <button
                    key={o.name}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void connect(o.name)}
                    className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-raised/40 px-3 py-2 text-left text-sm text-ink transition-colors hover:border-line-strong hover:bg-raised/70 disabled:opacity-60"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- wallet icons are data: URIs from the extension */}
                    <img src={o.icon} alt="" width={22} height={22} className="rounded-md" />
                    <span className="flex-1">{o.name}</span>
                    {busy === o.name && <span className="text-xs text-ink-3">Menunggu…</span>}
                  </button>
                ))}
              </div>
              <div className="mt-3 border-t border-line pt-3">
                <label htmlFor="watch-address" className="text-xs text-ink-3">
                  Atau pantau alamat
                </label>
                <div className="mt-1.5 flex gap-2">
                  <input
                    id="watch-address"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && watch()}
                    placeholder="Alamat wallet Solana"
                    className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 font-mono text-xs text-ink placeholder:font-sans placeholder:text-ink-3 focus:border-accent/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={watch}
                    className="rounded-xl border border-white/[0.08] bg-raised/60 px-3 text-xs font-medium text-ink hover:border-line-strong"
                  >
                    Pantau
                  </button>
                </div>
              </div>
              {error && <p className="mt-2 text-xs text-down">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
