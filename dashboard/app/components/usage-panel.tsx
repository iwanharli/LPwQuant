"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL, integer } from "../lib/format";
import type { UsageItem } from "../lib/types";
import { StatusDot } from "./ui";

const REFRESH_MS = 30_000;

const KIND_LABELS: Record<UsageItem["kind"], string> = {
  http: "RPC call",
  http_error: "RPC error",
  ws_subscribe: "WS subscribe",
  ws_message: "WS pesan",
};

export default function UsagePanel() {
  const [items, setItems] = useState<UsageItem[] | null>(null);
  const [failed, setFailed] = useState(false);

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

  const http = items?.find((i) => i.kind === "http");
  const errors = items?.filter((i) => i.kind === "http_error").reduce((n, i) => n + i.last_24h, 0) ?? 0;
  const coverage = items?.length ? Math.max(...items.map((i) => i.hours_covered)) : 0;

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel/85 shadow-[0_12px_36px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex w-full flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 text-sm">
        <span className="font-semibold text-ink">Pemakaian RPC</span>
        {failed ? (
          <span className="flex items-center gap-2 text-ink-2">
            <StatusDot severity="critical" /> Gagal memuat
          </span>
        ) : (
          <>
            <span className="text-ink-3">
              24 jam <span className="tabular-nums text-ink-2">{integer.format(http?.last_24h ?? 0)}</span> call
            </span>
            <span className="text-ink-3">
              Proyeksi 30 hari{" "}
              <span className="tabular-nums text-ink-2">
                {http?.projected_30d != null ? integer.format(http.projected_30d) : "–"}
              </span>
            </span>
            <span className="flex items-center gap-2 text-ink-3">
              <StatusDot severity={errors > 0 ? "warning" : "good"} />
              {integer.format(errors)} error
            </span>
          </>
        )}
      </div>

      {items && (
        <div className="border-t border-line bg-bg/25 px-4 pb-4">
          {items.length === 0 ? (
            <p className="pt-3 text-sm text-ink-3">Belum ada pemakaian tercatat.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="mt-2 w-full min-w-[560px] text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-ink-3">
                  <tr>
                    <th className="py-2 text-left font-medium">Provider</th>
                    <th className="py-2 text-left font-medium">Jenis</th>
                    <th className="py-2 text-right font-medium">Jam ini</th>
                    <th className="py-2 text-right font-medium">24 jam</th>
                    <th className="py-2 text-right font-medium">Bulan ini</th>
                    <th className="py-2 text-right font-medium">Proyeksi 30 hari</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {items.map((i) => (
                    <tr key={`${i.provider}-${i.kind}`} className="border-t border-line/80">
                      <td className="py-2 text-ink">{i.provider}</td>
                      <td className="py-2 text-ink-2">{KIND_LABELS[i.kind] ?? i.kind}</td>
                      <td className="py-2 text-right text-ink-2">{integer.format(i.this_hour)}</td>
                      <td className="py-2 text-right text-ink-2">{integer.format(i.last_24h)}</td>
                      <td className="py-2 text-right text-ink-2">{integer.format(i.this_month)}</td>
                      <td className="py-2 text-right font-medium text-ink">
                        {i.projected_30d == null ? "–" : integer.format(i.projected_30d)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-ink-3">
            Jumlah panggilan dan pesan, bukan kredit.
            {coverage < 24 && ` Data baru ${coverage.toFixed(1)} jam, proyeksi masih kasar.`}
          </p>
        </div>
      )}
    </section>
  );
}
