import type { ReactNode } from "react";

/**
 * The same header on every portfolio sub-page: fixed height, so switching tabs never shifts the page, a one-line
 * subtitle, and an optional right side (wallet, last update, refresh).
 */
export default function PortfolioHeader({ subtitle, right }: { subtitle: string; right?: ReactNode }) {
  return (
    <div className="flex h-20 items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Portofolio LP</h1>
        <p className="mt-1 truncate text-sm text-ink-3">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{right}</div>
    </div>
  );
}
