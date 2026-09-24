"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/portfolio/summary", label: "Ringkasan" },
  { href: "/portfolio", label: "Posisi LP" },
  { href: "/portfolio/orders", label: "Limit order" },
  { href: "/portfolio/history", label: "Riwayat" },
];

/** Sub-pages of the portfolio: LP positions and the coins held in the wallet itself. */
export default function PortfolioTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex w-fit gap-1 rounded-xl border border-line bg-panel p-1 backdrop-blur-sm" aria-label="Bagian portofolio">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-accent/15 text-accent" : "text-ink-2 hover:bg-raised/50 hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
