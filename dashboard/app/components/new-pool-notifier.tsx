"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ENGINE_URL, usdCompact } from "../lib/format";

type NewPool = {
  address: string;
  name: string;
  tvl: number;
  pool_age_hours: number;
  token_kind: "new" | "old" | null;
  verdict: "ok" | "pending" | "blocked";
  danger?: string[];
};

const KEY = "notify:new-token-pools";
const SEEN_KEY = "notify:seen-pools";
const EVERY_MS = 15_000;

function readOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribePermission(cb: () => void) {
  window.addEventListener("focus", cb);
  return () => window.removeEventListener("focus", cb);
}

/**
 * Browser notification for every new pool whose token is itself new (launched within a day). Runs while any quant
 * tab is open, in the background too. The bell turns it on (asking the browser's permission) and off; the choice
 * and the pools already announced are remembered in this browser, so a reload does not repeat them.
 */
export default function NewPoolNotifier() {
  const [on, setOn] = useState(false);
  const permission = useSyncExternalStore(
    subscribePermission,
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    () => "default",
  );
  const seen = useRef<Set<string> | null>(null);
  const router = useRouter();

  useEffect(() => {
    // Read the stored choice after mount so the server and first client render match.
    const t = setTimeout(() => setOn(readOn()), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!on || permission !== "granted") return;
    if (!seen.current) {
      try {
        seen.current = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
      } catch {
        seen.current = new Set();
      }
    }
    let first = seen.current.size === 0;
    const check = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/new-pools?max_age_hours=1&min_tvl=500`);
        if (!res.ok) return;
        const pools = ((await res.json()) as { pools: NewPool[] }).pools.filter((p) => p.token_kind === "new");
        const known = seen.current!;
        for (const p of pools) {
          if (known.has(p.address)) continue;
          known.add(p.address);
          if (first) continue; // the first look only learns what already exists
          const danger = (p.danger?.length ?? 0) >= 2;
          const status = danger ? "☠ BERBAHAYA" : p.verdict === "ok" ? "✅ Lolos cek" : p.verdict === "pending" ? "⏳ Menunggu RugCheck" : "⛔ Tidak lolos";
          const n = new Notification(`🐣 Pool token baru: ${p.name.replace("-", "/")}`, {
            body: `${status} · TVL ${usdCompact.format(p.tvl)} · dibuat ${Math.max(1, Math.round(p.pool_age_hours * 60))} mnt lalu`,
            tag: p.address,
            icon: "/favicon.ico",
          });
          n.onclick = () => {
            window.focus();
            router.push(`/pool/${p.address}`);
          };
        }
        first = false;
        localStorage.setItem(SEEN_KEY, JSON.stringify([...known].slice(-500)));
      } catch {
        // offline for a moment: the next check catches up
      }
    };
    void check();
    const t = setInterval(check, EVERY_MS);
    return () => clearInterval(t);
  }, [on, permission, router]);

  if (permission === "unsupported") return null;

  const toggle = async () => {
    if (on) {
      setOn(false);
      try {
        localStorage.setItem(KEY, "0");
      } catch {}
      return;
    }
    const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (p !== "granted") return;
    setOn(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
  };

  const active = on && permission === "granted";
  return (
    <button
      type="button"
      onClick={toggle}
      title={
        permission === "denied"
          ? "Notifikasi diblokir browser: izinkan dulu di pengaturan situs"
          : active
            ? "Notifikasi pool token baru: aktif (klik untuk matikan)"
            : "Nyalakan notifikasi browser untuk pool dengan token baru"
      }
      aria-pressed={active}
      className={`relative grid h-9 w-9 place-items-center rounded-lg border transition-colors ${
        active ? "border-accent/50 bg-accent/10 text-accent" : "border-white/[0.06] bg-panel/60 text-ink-3 hover:border-line-strong hover:text-ink"
      }`}
    >
      <svg viewBox="0 0 20 20" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5h-13S5 12 5 8Z" />
        <path d="M8.5 16.5a1.6 1.6 0 0 0 3 0" />
        {!active && <path d="M3 3l14 14" />}
      </svg>
      {active && <span className="live-dot absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
    </button>
  );
}
