"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ENGINE_URL, integer } from "../lib/format";
import type { UsageItem } from "../lib/types";
import { StatusDot } from "./ui";
import { SkeletonTable } from "./skeleton";

const REFRESH_MS = 30_000;

const KIND_LABELS: Record<UsageItem["kind"], string> = {
  http: "RPC call",
  http_error: "RPC error",
  ws_subscribe: "WS subscribe",
  ws_message: "WS pesan",
};
/** HTTP APIs counted alongside the Solana RPC providers; anything else is an RPC provider. */
const API_SOURCES: Record<string, string> = {
  meteora: "Meteora",
  geckoterminal: "GeckoTerminal",
  rugcheck: "RugCheck",
  jupiter: "Jupiter",
  gmgn: "GMGN",
  "pump.fun": "pump.fun",
};
const isApi = (provider: string) => provider in API_SOURCES;

function kindLabel(i: UsageItem): string {
  if (isApi(i.provider) && i.kind === "http") return "API call";
  if (isApi(i.provider) && i.kind === "http_error") return "API error";
  return KIND_LABELS[i.kind] ?? i.kind;
}

/** Under an hour of counting, a 30-day projection mostly measures the start-up burst: leave it out. */
const MIN_PROJECTION_HOURS = 1;
const projection = (i: UsageItem) => (i.hours_covered >= MIN_PROJECTION_HOURS ? i.projected_30d : null);

const KIND_ORDER: UsageItem["kind"][] = ["http", "http_error", "ws_subscribe", "ws_message"];

function Tile({ label, value, hint }: { label: ReactNode; value: ReactNode; hint: ReactNode }) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-panel px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
      <div className="flex min-w-0 items-center gap-2 truncate text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-ink">{value}</div>
      <div className="mt-1 truncate text-xs text-ink-3">{hint}</div>
    </div>
  );
}

function useUsage() {
  const [items, setItems] = useState<UsageItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/usage`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { items: UsageItem[] };
        if (!cancelled) {
          setItems(body.items);
          setFailed(false);
          setUpdatedAt(Date.now());
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return { items, failed, updatedAt };
}

const sum = (items: UsageItem[], kind: UsageItem["kind"], field: "last_24h" | "this_month" | "this_hour") =>
  items.filter((i) => i.kind === kind).reduce((n, i) => n + i[field], 0);

export default function UsagePanel({ onItems }: { onItems?: (items: UsageItem[]) => void } = {}) {
  const { items, failed, updatedAt } = useUsage();
  useEffect(() => {
    if (items && onItems) onItems(items);
  }, [items, onItems]);
  const all = items ?? [];
  const calls24 = sum(all, "http", "last_24h");
  const errors24 = sum(all, "http_error", "last_24h");
  const errorRate = calls24 > 0 ? (errors24 / calls24) * 100 : 0;
  const projected = all
    .filter((i) => i.kind === "http")
    .reduce((n, i) => n + (projection(i) ?? 0), 0);
  const unprojected = all.filter((i) => i.kind === "http" && i.hours_covered < MIN_PROJECTION_HOURS).length;
  const coverage = all.length ? Math.max(...all.map((i) => i.hours_covered)) : 0;
  const providers = [...new Set(all.map((i) => i.provider))].sort(
    (a, b) =>
      all.filter((i) => i.provider === b && i.kind === "http").reduce((n, i) => n + i.last_24h, 0) -
      all.filter((i) => i.provider === a && i.kind === "http").reduce((n, i) => n + i.last_24h, 0),
  );

  return (
    <div className="space-y-5">
      {failed && (
        <p className="flex items-center gap-2 rounded-2xl border border-critical/30 bg-critical/10 px-4 py-3 text-sm text-ink-2 shadow-sm shadow-black/20">
          <StatusDot severity="critical" /> Gagal memuat pemakaian. Pastikan engine berjalan di {ENGINE_URL}.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Call 24 jam"
          value={items ? integer.format(calls24) : "–"}
          hint={`${integer.format(all.filter((i) => i.kind === "http" && !isApi(i.provider)).reduce((n, i) => n + i.last_24h, 0))} RPC · ${integer.format(sum(all, "http", "this_hour"))} jam ini`}
        />
        <Tile
          label="Proyeksi 30 hari"
          value={items ? integer.format(projected) : "–"}
          hint={
            unprojected > 0
              ? `${unprojected} sumber baru belum dihitung (< 1 jam data)`
              : coverage < 24
                ? `Data baru ${coverage.toFixed(1)} jam, masih kasar`
                : "Dari laju 24 jam terakhir"
          }
        />
        <Tile
          label={
            <>
              <StatusDot severity={errors24 === 0 ? "good" : errorRate < 1 ? "warning" : "critical"} /> Error 24 jam
            </>
          }
          value={items ? integer.format(errors24) : "–"}
          hint={calls24 > 0 ? `${errorRate.toFixed(2)}% dari call` : "Belum ada call"}
        />
        <Tile
          label="WS pesan bulan ini"
          value={items ? integer.format(sum(all, "ws_message", "this_month")) : "–"}
          hint={`${integer.format(sum(all, "ws_subscribe", "this_month"))} subscribe`}
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Hitungan panggilan per sumber</h2>
          <span className="text-xs text-ink-3">
            Jumlah panggilan dan pesan, bukan kredit
            {updatedAt &&
              ` · diperbarui ${new Date(updatedAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" })} WIB`}
          </span>
        </div>
        {!items ? (
          failed ? <p className="px-4 py-8 text-sm text-ink-3">Tidak ada data.</p> : <SkeletonTable rows={7} columns={5} title={false} />
        ) : items.length === 0 ? (
          <p className="px-4 py-8 text-sm text-ink-3">Belum ada pemakaian tercatat.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm tabular-nums">
              <thead className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2.5 text-left font-medium">Provider</th>
                  <th className="px-3 py-2.5 text-left font-medium">Jenis</th>
                  <th className="px-3 py-2.5 text-right font-medium">Jam ini</th>
                  <th className="px-3 py-2.5 text-left font-medium">24 jam</th>
                  <th className="px-3 py-2.5 text-right font-medium">Bulan ini</th>
                  <th className="px-4 py-2.5 text-right font-medium">Proyeksi 30 hari</th>
                </tr>
              </thead>
              {providers.map((provider) => {
                const rows = items
                  .filter((i) => i.provider === provider)
                  .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
                return (
                  <tbody key={provider} className="border-b border-line last:border-b-0">
                    {rows.map((i, idx) => {
                      const isError = i.kind === "http_error";
                      const share = i.kind === "http" && calls24 > 0 ? (i.last_24h / calls24) * 100 : null;
                      return (
                        <tr key={i.kind} className="transition-colors hover:bg-raised/30">
                          <td className="px-4 py-2.5 align-middle">
                            {idx === 0 && <span className="flex flex-col">
                                <span className="font-semibold text-ink">
                                  {API_SOURCES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)}
                                </span>
                                <span className="text-[11px] text-ink-3">{isApi(provider) ? "HTTP API" : "Solana RPC"}</span>
                              </span>}
                          </td>
                          <td className="px-3 py-2.5 text-ink-2">
                            <span className="inline-flex items-center gap-2">
                              {isError && <StatusDot severity={i.last_24h > 0 ? "warning" : "good"} />}
                              {kindLabel(i)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right text-ink-2">{integer.format(i.this_hour)}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-3">
                              <span className="w-16 text-right text-ink">{integer.format(i.last_24h)}</span>
                              {share != null && (
                                <span
                                  className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-raised sm:block"
                                  title={`${share.toFixed(0)}% dari semua call`}
                                >
                                  <span className="block h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right text-ink-2">{integer.format(i.this_month)}</td>
                          <td className="px-4 py-2.5 text-right font-medium text-ink">
                            {projection(i) == null ? (
                              <span className="text-ink-3" title={i.hours_covered < MIN_PROJECTION_HOURS ? "Data kurang dari 1 jam" : undefined}>
                                –
                              </span>
                            ) : (
                              integer.format(projection(i)!)
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
