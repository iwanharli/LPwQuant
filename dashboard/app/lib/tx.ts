"use client";

import { CLAIM_URL, ENGINE_URL } from "./format";

/** POST to the local transaction builder (ingestor/src/claim-server.ts), which builds and simulates but never signs
 * for the user. Errors come back as `{ detail }`. */
export async function buildTx<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CLAIM_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.detail ?? `HTTP ${res.status}`);
  return json as T;
}

export const decodeTx = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function friendlyTxError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Gagal";
  if (/reject|cancel|denied|declined/i.test(message)) return "Dibatalkan di wallet";
  if (/429|too many requests|rate limit/i.test(message)) return "RPC sedang sibuk (rate limit). Coba lagi sebentar lagi.";
  if (/failed to fetch|networkerror/i.test(message)) return "Ingestor tidak bisa dihubungi. Pastikan ingestor berjalan.";
  if (/custom program error: 0x1\b|insufficient/i.test(message)) return "Saldo token tidak cukup.";
  return message;
}

/** Tells the engine about an action the app just sent, so the history shows it at once with what the app knows
 * (kind, pool, note). The chain sync fills in the exact token changes minutes later. Best effort: a failed log
 * never fails the action itself. */
export function logActivity(entry: {
  wallet: string;
  kind: "claim" | "limit_order_place" | "limit_order_cancel" | "remove_liquidity" | "swap";
  signatures: string[];
  pool?: string;
  note?: string;
}): void {
  void fetch(`${ENGINE_URL}/api/portfolio/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  }).catch(() => undefined);
}
