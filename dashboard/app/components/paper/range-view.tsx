import { fmtNum } from "../../lib/format";

/** Same colours as the open-position bin chart on the portfolio page. */
const TOKEN_COLOR = "#8b6cf6";
const QUOTE_COLOR = "#3ec6e0";

export type RangeShape = "spot" | "bid_ask" | "curve";

/**
 * A paper position's range drawn like the portfolio's bin chart, without on-chain bins: the liquidity shape its
 * strategy lays down between the range's low and high price, which side of the current price each bin is on (the
 * token above it has not been sold yet, the quote below it has bought in), and a dot at the current price.
 * Bins are log-spaced, as DLMM's are.
 */
function bars(min: number, max: number, current: number, shape: RangeShape, count: number) {
  const out = [];
  const lmin = Math.log(min);
  const lmax = Math.log(max);
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count; // 0 at the low end, 1 at the high end
    const price = Math.exp(lmin + (lmax - lmin) * t);
    const mid = Math.abs(t - 0.5) * 2; // 0 at the middle, 1 at the edges
    const weight = shape === "bid_ask" ? 0.25 + mid : shape === "curve" ? 1.25 - mid : 1;
    out.push({ price, weight, above: price > current });
  }
  return out;
}

export function rangePosition(min: number, max: number, current: number): number {
  return (Math.log(current) - Math.log(min)) / (Math.log(max) - Math.log(min));
}

/** Thin one-line version for a table row: the range as a bar, the current price as a dot. */
export function RangeStrip({ min, max, current }: { min: number; max: number; current: number | null }) {
  if (!(min > 0 && max > min) || current == null || !(current > 0)) return null;
  const pos = rangePosition(min, max, current);
  const inside = pos >= 0 && pos <= 1;
  const left = Math.min(100, Math.max(0, pos * 100));
  return (
    <div className="mt-1.5 flex w-40 items-center gap-1.5" title={inside ? `Harga di ${fmtNum(pos * 100, 0)}% range` : "Harga di luar range"}>
      <div className="relative h-1.5 flex-1 rounded-full" style={{ background: `linear-gradient(90deg, ${QUOTE_COLOR}66, ${TOKEN_COLOR}66)` }}>
        <span
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel ${inside ? "bg-white" : "bg-amber-300"}`}
          style={{ left: `${left}%` }}
        />
      </div>
      <span className={`w-9 text-right text-[10px] tabular-nums ${inside ? "text-ink-3" : "text-amber-300"}`}>
        {inside ? `${fmtNum(pos * 100, 0)}%` : pos < 0 ? "bawah" : "atas"}
      </span>
    </div>
  );
}

/** The full chart for a row's detail panel. */
export default function RangeView({
  min,
  max,
  current,
  entry,
  shape = "spot",
  bins = 40,
  quote = "SOL",
  token = "token",
}: {
  min: number;
  max: number;
  current: number | null;
  entry?: number | null;
  shape?: RangeShape;
  bins?: number;
  quote?: string;
  token?: string;
}) {
  if (!(min > 0 && max > min)) return null;
  const now = current && current > 0 ? current : entry ?? min;
  const list = bars(min, max, now, shape, Math.min(Math.max(bins, 12), 70));
  const maxW = Math.max(...list.map((b) => b.weight));
  const pos = rangePosition(min, max, now);
  const inside = pos >= 0 && pos <= 1;
  const activeIdx = inside ? Math.min(list.length - 1, Math.floor(pos * list.length)) : -1;
  const p = (n: number) => fmtNum(n, n < 1 ? 10 : 4);
  return (
    <div>
      <div className="relative flex h-24 items-end gap-[2px] rounded-lg bg-black/35 px-2 pt-3" role="img" aria-label="Range posisi per bin">
        {list.map((b, i) => (
          <div
            key={i}
            title={`harga ${p(b.price)} · ${b.above ? `berisi ${token}` : `berisi ${quote}`}`}
            className="relative min-w-[2px] flex-1 rounded-t-[3px]"
            style={{ height: `${Math.max(6, (b.weight / maxW) * 100)}%`, background: i === activeIdx ? "#f4f6fa" : b.above ? TOKEN_COLOR : QUOTE_COLOR }}
          >
            {i === activeIdx && (
              <span className="absolute -top-2 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
            )}
          </div>
        ))}
        {!inside && (
          <span className={`absolute top-2 text-[11px] font-medium text-amber-300 ${pos < 0 ? "left-2" : "right-2"}`}>
            {pos < 0 ? "◀ harga di bawah range" : "harga di atas range ▶"}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-ink-3">
        <span>{p(min)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: QUOTE_COLOR }} /> {quote}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: TOKEN_COLOR }} /> {token}
          </span>
          <span className="text-ink-2">
            sekarang {p(now)}
            {inside ? ` · ${fmtNum(pos * 100, 0)}% range` : ""}
          </span>
        </span>
        <span>{p(max)}</span>
      </div>
    </div>
  );
}
