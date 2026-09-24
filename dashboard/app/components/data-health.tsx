"use client";

import { useEffect, useRef, useState } from "react";
import { ENGINE_URL, fmtTime } from "../lib/format";
import type { ConnectionStatus } from "../lib/types";
import { StatusDot } from "./ui";

type FreshnessItem = {
  key: string;
  label: string;
  last_ts: number | null;
  age_sec: number | null;
  max_age_sec: number;
  status: "ok" | "stale" | "off";
};

type Freshness = { generated_at: number; ok: boolean; stale: string[]; items: FreshnessItem[] };

const REFRESH_MS = 30_000;

function fmtAge(sec: number | null): string {
  if (sec == null) return "belum ada data";
  if (sec < 90) return `${Math.round(sec)} dtk lalu`;
  if (sec < 5400) return `${Math.round(sec / 60)} mnt lalu`;
  return `${(sec / 3600).toFixed(1)} jam lalu`;
}

/** The top bar's one status pill: socket state and data freshness in a single label, because two chips saying
 * "Live" and "Data segar" read as the same thing. They are not the same measurement -- the socket is this
 * browser's connection, freshness comes from /api/freshness on the engine -- so the pill shows the worse of the
 * two and never reports "Live" while a source has gone stale. Click it for per-source ages. */
export default function DataHealth({
  status,
  lastMessageAt,
}: {
  status?: ConnectionStatus;
  lastMessageAt?: number | null;
}) {
  const [data, setData] = useState<Freshness | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/freshness`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Freshness;
        if (!cancelled) {
          setData(body);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
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
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Worst of the two wins, so a dead socket or a stale source can never hide behind a green "Live".
  const socketBad = status === "offline" ? "critical" : status === "connecting" ? "warning" : null;
  const freshBad = failed ? "critical" : !data ? null : data.ok ? null : "warning";
  const severity = socketBad === "critical" || freshBad === "critical"
    ? "critical"
    : socketBad === "warning" || freshBad === "warning"
      ? "warning"
      : !data
        ? "info"
        : "good";
  const label = failed
    ? "Engine tidak terjangkau"
    : status === "offline"
      ? "Terputus"
      : status === "connecting"
        ? "Menghubungkan"
        : !data
          ? "Cek data…"
          : !data.ok
            ? `${data.stale.length} sumber basi`
            : lastMessageAt
              ? `Live ${fmtTime(lastMessageAt)}`
              : "Live";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={data && !data.ok ? `Basi: ${data.stale.join(", ")}` : undefined}
        className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 font-medium shadow-sm shadow-black/20 transition-colors ${
          severity === "warning" || severity === "critical"
            ? "border-warning/40 bg-warning/10 text-ink hover:bg-warning/15"
            : "border-white/[0.06] bg-panel/80 text-ink-2 hover:text-ink"
        }`}
      >
        <StatusDot severity={severity} />
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Kesegaran data"
          className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-2xl border border-line-strong bg-raised shadow-2xl shadow-black/50"
        >
          <div className="border-b border-line px-4 py-2.5 text-xs text-ink-3">
            Kesegaran data{data ? ` · dicek ${fmtTime(data.generated_at)} WIB` : ""}
          </div>
          {failed && (
            <p className="px-4 py-3 text-sm text-ink-2">
              Tidak bisa menghubungi engine di {ENGINE_URL}. Pastikan engine berjalan.
            </p>
          )}
          {data && (
            <ul className="divide-y divide-line">
              {data.items.map((item) => (
                <li key={item.key} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusDot severity={item.status === "ok" ? "good" : item.status === "stale" ? "warning" : "info"} />
                    <span className="truncate text-ink">{item.label}</span>
                  </span>
                  <span
                    className={`shrink-0 text-xs tabular-nums ${item.status === "stale" ? "text-warning" : "text-ink-3"}`}
                    title={`Batas ${Math.round(item.max_age_sec / 60)} menit`}
                  >
                    {item.status === "off" ? "tidak aktif" : fmtAge(item.age_sec)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
