import type { ReactNode } from "react";

/**
 * The one header every page uses: fixed height, so the content below starts at the same line on every page and
 * nothing shifts when switching between them. The subtitle stays on one line.
 */
export default function PageHeader({ title, subtitle, right }: { title: ReactNode; subtitle: string; right?: ReactNode }) {
  return (
    <div className="flex h-20 items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-3xl font-bold tracking-tight text-ink sm:text-4xl">{title}</h1>
        <p className="mt-1 truncate text-sm text-ink-3">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{right}</div>
    </div>
  );
}
