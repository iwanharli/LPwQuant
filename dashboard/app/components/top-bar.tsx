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
  { href: "/portfolio", label: "Portofolio LP" },
  { href: "/wallet", label: "Wallet" },
  { href: "/rpc", label: "Pemakaian API" },
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
            <div className="text-base font-bold tracking-tight text-ink">Quant</div>
            <div className="text-[11px] text-ink-3">Meteora DLMM · LP Screener</div>
          </div>
        </Link>

        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-7 text-sm font-medium md:flex">
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
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
