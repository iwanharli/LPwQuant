"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL } from "../lib/format";

type State = "unsupported" | "ios-install" | "denied" | "off" | "on" | "busy";

function b64ToBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * The bell: Web Push for new pools of newly launched tokens. The server sends them, so they arrive with every quant
 * tab closed, on a phone too. On iPhone this needs quant installed to the home screen first (Share > Add to Home
 * Screen); the bell says so instead of failing.
 */
export default function NewPoolNotifier() {
  const [state, setState] = useState<State>("busy");

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
        return ios && !standalone ? "ios-install" : "unsupported";
      }
      if (Notification.permission === "denied") return "denied";
      return (await currentSubscription()) ? "on" : "off";
    };
    check()
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setState("off"));
    return () => {
      cancelled = true;
    };
  }, []);

  const turnOn = async () => {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setState(permission === "denied" ? "denied" : "off");
      const { public_key } = (await (await fetch(`${ENGINE_URL}/api/push/key`)).json()) as { public_key: string | null };
      if (!public_key) return setState("off");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(public_key) as BufferSource });
      await fetch(`${ENGINE_URL}/api/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...sub.toJSON(), user_agent: navigator.userAgent }),
      });
      await fetch(`${ENGINE_URL}/api/push/test`, { method: "POST" });
      setState("on");
    } catch {
      setState("off");
    }
  };

  const turnOff = async () => {
    setState("busy");
    try {
      const sub = await currentSubscription();
      if (sub) {
        await fetch(`${ENGINE_URL}/api/push/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        });
        await sub.unsubscribe();
      }
    } finally {
      setState("off");
    }
  };

  if (state === "unsupported") return null;
  const active = state === "on";
  const title = {
    "ios-install": "Di iPhone: pasang quant ke layar utama dulu (Bagikan → Tambah ke Layar Utama), lalu buka dari ikonnya untuk menyalakan notifikasi",
    denied: "Notifikasi diblokir browser: izinkan dulu di pengaturan situs",
    off: "Nyalakan notifikasi pool token baru (tetap datang meski browser ditutup)",
    on: "Notifikasi pool token baru aktif di perangkat ini (klik untuk matikan)",
    busy: "Menyiapkan notifikasi…",
  }[state];

  return (
    <button
      type="button"
      onClick={() => (state === "on" ? turnOff() : state === "off" ? turnOn() : state === "ios-install" || state === "denied" ? window.alert(title) : undefined)}
      title={title}
      aria-pressed={active}
      disabled={state === "busy"}
      className={`relative grid h-9 w-9 place-items-center rounded-lg border transition-colors disabled:opacity-60 ${
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
