import type { ReactNode } from "react";

/**
 * The one header every page uses: fixed height, so the content below starts at the same line on every page and
 * nothing shifts when switching between them. The subtitle stays on one line.
 */
export default function PageHeader({
  title,
  accent,
  subtitle,
  right,
}: {
  title: ReactNode;
  /** Second half of the title, set in the accent gradient. */
  accent?: string;
  subtitle: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex h-20 items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
          {title}
          {accent && <span className="text-accent-gradient"> {accent}</span>}
        </h1>
        <p className="mt-1.5 truncate text-sm text-ink-3">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{right}</div>
    </div>
  );
}
