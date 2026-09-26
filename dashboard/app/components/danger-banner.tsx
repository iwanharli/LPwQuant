/** The loudest warning on the site: a pool with several signs of being its creator's own setup, not a market. */
export default function DangerBanner({ signs, compact = false }: { signs: string[] | undefined; compact?: boolean }) {
  if (!signs || signs.length < 2) return null;
  if (compact) {
    return (
      <span
        title={signs.join("\n")}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-rose-500/60 bg-rose-500/15 px-2 py-0.5 text-[11px] font-bold text-rose-200"
      >
        ☠ Berbahaya
      </span>
    );
  }
  return (
    <div className="danger-pulse rounded-2xl border-2 border-rose-500/70 bg-rose-950/60 px-5 py-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-2xl leading-none">☠</span>
        <div className="min-w-0">
          <div className="text-lg font-extrabold text-rose-100">Pool sangat mencurigakan — jangan masuk</div>
          <p className="mt-1 text-sm leading-6 text-rose-100/85">
            Ada {signs.length} tanda sekaligus bahwa ini pool buatan pemilik token sendiri, bukan pasar sungguhan. Pola ini biasa dipakai untuk token
            palsu atau umpan rug pull: harga dan TVL bisa dikarang, dan likuiditas bisa ditarik kapan saja.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-rose-50">
            {signs.map((s) => (
              <li key={s} className="flex gap-2">
                <span className="text-rose-400">•</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
