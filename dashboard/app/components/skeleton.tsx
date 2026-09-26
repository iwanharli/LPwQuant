/**
 * Loading shapes that match what is about to appear, so the page does not jump when the data lands and nobody has
 * to read the word "Memuat" to know what is coming.
 *
 * Every block is one pulsing rectangle; the page-level helpers below just arrange them the way each page arranges
 * its real content.
 */
export function SkeletonBox({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded bg-white/[0.06] ${className}`} style={style} aria-hidden />;
}

/** The KPI tiles most pages open with. */
export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-4">
          <SkeletonBox className="h-3 w-24" />
          <SkeletonBox className="mt-3 h-6 w-32" />
          <SkeletonBox className="mt-3 h-3 w-40" />
        </div>
      ))}
    </div>
  );
}

/** A table: header strip, then rows of the same height as the real ones. */
export function SkeletonTable({ rows = 8, columns = 5, title = true }: { rows?: number; columns?: number; title?: boolean }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel" aria-busy="true">
      {title && (
        <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
          <SkeletonBox className="h-3.5 w-40" />
          <SkeletonBox className="h-3 w-24" />
        </div>
      )}
      <div className="divide-y divide-white/[0.04]">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5" style={{ opacity: 1 - i * (0.6 / rows) }}>
            <SkeletonBox className="h-8 w-8 shrink-0 rounded-full" />
            <SkeletonBox className="h-3.5 flex-1" />
            {Array.from({ length: columns - 1 }, (_, c) => (
              <SkeletonBox key={c} className="hidden h-3.5 w-16 sm:block" />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Cards in a grid, like the position history and the pool cards. */
export function SkeletonCards({ count = 4, columns = "lg:grid-cols-2 2xl:grid-cols-3" }: { count?: number; columns?: string }) {
  return (
    <div className={`grid gap-3 ${columns}`} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-2xl border border-white/[0.06] bg-panel p-4">
          <div className="flex items-center justify-between gap-3">
            <SkeletonBox className="h-4 w-28" />
            <SkeletonBox className="h-4 w-36 rounded-full" />
          </div>
          <SkeletonBox className="mt-3 h-7 w-40" />
          <SkeletonBox className="mt-4 h-2.5 w-full rounded-full" />
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            {Array.from({ length: 6 }, (_, t) => (
              <SkeletonBox key={t} className="h-[74px] rounded-xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A chart panel: title strip and the plot area. */
export function SkeletonChart({ height = 260 }: { height?: number }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel" aria-busy="true">
      <div className="border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <SkeletonBox className="h-3.5 w-44" />
      </div>
      <div className="px-4 py-4">
        <SkeletonBox className="w-full rounded-xl" style={{ height }} />
      </div>
    </section>
  );
}

/** One card split into KPI cells, the strip the paper-test pages open with. */
export function SkeletonStrip({ count = 4 }: { count?: number }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel" aria-busy="true">
      <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="bg-panel px-4 py-3.5">
            <SkeletonBox className="h-2.5 w-20" />
            <SkeletonBox className="mt-2.5 h-6 w-28" />
            <SkeletonBox className="mt-2 h-2.5 w-36" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** A sub-tab bar with its underline. */
export function SkeletonTabs({ count = 4 }: { count?: number }) {
  return (
    <div className="flex gap-1 border-b border-line pb-2.5 pt-2" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonBox key={i} className="mx-3 h-4 w-24" />
      ))}
    </div>
  );
}
