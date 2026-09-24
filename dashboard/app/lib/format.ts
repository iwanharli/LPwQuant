// Same-origin proxies (app/api/engine, app/api/tx): the engine and the transaction builder stay on localhost and
// every call carries the login session. NEXT_PUBLIC_* still overrides them for a direct-to-engine setup.
export const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "/api/engine";
/** Builds unsigned claim-fee transactions (ingestor/src/claim-server.ts); never signs anything. */
export const CLAIM_URL = process.env.NEXT_PUBLIC_CLAIM_URL ?? "/api/tx";
export const TIMEZONE = "Asia/Jakarta"; // GMT+7

export const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

export const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export const integer = new Intl.NumberFormat("id-ID");
export const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v !== 0 && Math.abs(v) < 0.0001) return v.toExponential(3);
  return v.toPrecision(5);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  return v == null ? "–" : `${v.toFixed(digits)}%`;
}

/** Price distance between adjacent bins, in percent (bin step is in basis points). */
export function binStepPct(binStep: number): string {
  return `${(binStep / 100).toFixed(2)}%`;
}

export const BINS_PER_POSITION = 70; // Meteora SDK DEFAULT_BIN_PER_POSITION

/** Total price span covered by one full position of BINS_PER_POSITION bins. */
export function positionSpanPct(binStep: number): number {
  return ((1 + binStep / 10_000) ** BINS_PER_POSITION - 1) * 100;
}

/**
 * Min/max price of a plan's range snapped to whole bins (the same bin counts the engine uses), so the
 * numbers match what you would enter on Meteora. Prices are in the quote token.
 */
export function binAlignedRange(price: number, binStep: number, lowPct: number, highPct: number) {
  const r = 1 + binStep / 10_000;
  // Mirrors engine/app/recommend.py: a fall of w% needs ln(1/(1-w)) of bins, a rise ln(1+w).
  const binsAbove = (w: number) => (w <= 0 ? 0 : Math.ceil(Math.log(1 + w / 100) / Math.log(r)));
  const binsBelow = (w: number) => (w <= 0 ? 0 : Math.ceil(-Math.log(1 - Math.min(w, 99) / 100) / Math.log(r)));
  const below = binsBelow(-lowPct);
  const above = binsAbove(highPct);
  return { min: price * r ** -below, max: price * r ** above, below, above };
}

/** Plain decimal (no exponent) with 6 significant digits, suitable for pasting into a price field. */
export function fmtPriceExact(v: number): string {
  if (!Number.isFinite(v)) return "–";
  return v.toLocaleString("en-US", { maximumSignificantDigits: 6, useGrouping: false });
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  return v == null ? "–" : v.toFixed(digits);
}

export function fmtSignedPct(v: number | null | undefined, digits = 1): string {
  if (v == null) return "–";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function fmtAge(hours: number | null): string {
  if (hours == null) return "–";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(0)}j`;
  return `${Math.floor(hours / 24)}h`;
}

export function fmtTime(ms: number, seconds = true): string {
  return new Date(ms).toLocaleTimeString("id-ID", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString("id-ID", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}j`;
  return `${(hours / 24).toFixed(1)}h`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
