"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fmtTime } from "../lib/format";
import type { ConnectionStatus } from "../lib/types";
import { ClockIcon } from "./icons";
import { StatusDot } from "./ui";

const STATUS_META: Record<ConnectionStatus, { label: string; severity: "good" | "warning" | "critical" }> = {
  live: { label: "Live", severity: "good" },
  connecting: { label: "Menghubungkan", severity: "warning" },
  offline: { label: "Terputus", severity: "critical" },
};

const NAV = [
  { href: "/", label: "Screener" },
  { href: "/paper", label: "Paper trading" },
];

function WibClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-ink-2">
      <ClockIcon className="text-ink-3" />
      {now ? fmtTime(now) : "--.--.--"} <span className="text-ink-3">WIB</span>
    </span>
  );
}

export default function TopBar({
  status,
  lastMessageAt,
}: {
  status?: ConnectionStatus;
  lastMessageAt?: number | null;
}) {
  const pathname = usePathname();
  const meta = status ? STATUS_META[status] : null;
  return (
    <header className="sticky top-0 z-30 border-b border-white/8 bg-bg/78 shadow-[0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[1680px] items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-3 rounded-lg">
          <span className="grid h-9 w-9 place-items-center rounded-lg border border-accent/30 bg-accent/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_10px_28px_rgba(73,164,255,0.14)]">
            <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden>
              <path
                d="M4 17 9 11l4 3 7-8"
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="hidden leading-tight sm:block">
            <div className="text-sm font-semibold tracking-tight text-ink">Quant</div>
            <div className="text-[11px] text-ink-3">Meteora DLMM · LP Screener</div>
          </div>
        </Link>

        <nav className="flex items-center gap-1 rounded-lg border border-line bg-panel/80 p-1 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition-colors ${
                  active ? "bg-raised text-ink shadow-sm shadow-black/20" : "text-ink-3 hover:bg-raised/50 hover:text-ink-2"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-xs sm:gap-5">
          {meta && (
            <span className="hidden text-ink-3 md:inline">
              {lastMessageAt ? `Update terakhir ${fmtTime(lastMessageAt)} WIB` : "Menunggu data…"}
            </span>
          )}
          <span className="hidden rounded-full border border-line bg-panel/50 px-3 py-1 sm:inline">
            <WibClock />
          </span>
          {meta && (
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/80 px-3 py-1.5 font-semibold shadow-sm shadow-black/20">
              <StatusDot severity={meta.severity} pulse={status === "live"} />
              {meta.label}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
