"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ConnectionStatus } from "../lib/types";
import DataHealth from "./data-health";
import WalletButton from "./wallet-button";

const NAV = [
  { href: "/", label: "Screener" },
  { href: "/new-pools", label: "Pool baru" },
  { href: "/paper", label: "Paper trading" },
  { href: "/leaders", label: "LP teratas" },
  { href: "/portfolio", label: "Portofolio LP" },
  { href: "/wallet", label: "Wallet" },
];

export default function TopBar({
  status,
  lastMessageAt,
}: {
  status?: ConnectionStatus;
  lastMessageAt?: number | null;
}) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-white/8 bg-bg/78 shadow-[0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl">
      <div className="relative mx-auto flex h-16 w-full items-center gap-4 px-4 sm:px-6 2xl:px-8">
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
            <div className="text-base font-extrabold tracking-tight text-ink">Quant</div>
            <div className="text-[11px] text-ink-3">Meteora DLMM · LP Screener</div>
          </div>
        </Link>

        {/* Pills rather than underlines: the active page reads at a glance, the way the reference sets its nav. */}
        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.03] p-1 text-sm font-medium md:flex">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-full px-3.5 py-1.5 transition-colors ${
                  active ? "bg-white/[0.08] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <nav className="flex items-center gap-4 text-sm font-medium md:hidden">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap transition-colors ${active ? "text-accent" : "text-ink-2 hover:text-ink"}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Two chips, not four: data freshness (click for per-source detail) and the socket state. The old
            "Update terakhir" line repeated the timestamp already inside the freshness panel and only appeared on
            2xl screens, and a wall clock says nothing about this system -- it now rides along as a tooltip. */}
        <div className="ml-auto flex items-center gap-2 text-xs">
          <DataHealth status={status} lastMessageAt={lastMessageAt} />
          {/* API usage is a check-up page, not a daily destination: an icon rather than a menu item. */}
          <Link
            href="/rpc"
            title="Pemakaian API"
            aria-label="Pemakaian API"
            aria-current={pathname.startsWith("/rpc") ? "page" : undefined}
            className={`grid h-9 w-9 place-items-center rounded-lg border transition-colors ${
              pathname.startsWith("/rpc")
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-white/[0.06] bg-panel/60 text-ink-3 hover:border-line-strong hover:text-ink"
            }`}
          >
            <svg viewBox="0 0 20 20" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden>
              <path d="M3 16.5h14M5.5 13V9.5M10 13V5M14.5 13v-6" />
            </svg>
          </Link>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
