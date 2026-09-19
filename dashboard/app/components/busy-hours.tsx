"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL, fmtNum } from "../lib/format";

type Profile = {
  profile: number[] | null;
  days: number;
  consistency: number | null;
  stable: boolean;
  peak_hours: number[];
};
type Market = { profile: number[] | null; pools: number; stable_share: number | null; peak_hours: number[] };
type Response = Partial<Profile> & { market: Market };

const FLAT = 100 / 24; // an hour's share if the day were flat

function wibHour(): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", hour: "2-digit", hour12: false }).format(new Date())) % 24;
}

function useBusyHours(pool?: string) {
  const [data, setData] = useState<Response | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${ENGINE_URL}/api/busy-hours${pool ? `?pool=${pool}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => !cancelled && body && setData(body as Response))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pool]);
  return data;
}

const range = (hours: number[]) => hours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");

/**
 * 24 bars, one per WIB hour: share of a day's volume. With a pool, its bars are drawn over the market's profile
 * (small ticks), and the label says whether the pool's own pattern held up across the month or is noise.
 */
export default function BusyHours({ pool, compact = false }: { pool?: string; compact?: boolean }) {
  const data = useBusyHours(pool);
  const [now] = useState(wibHour);
  if (!data) return <p className="text-xs text-ink-3">Memuat jam ramai…</p>;
  const market = data.market;
  const own = pool && data.profile ? data.profile : null;
  // An unstable pool's own bars would mislead: show the market's, and say so.
  const useOwn = !!own && !!data.stable;
  const bars = (useOwn ? own : market.profile) ?? [];
  if (bars.length !== 24) return <p className="text-xs text-ink-3">Belum ada cukup data candle.</p>;
  const max = Math.max(...bars, ...(market.profile ?? []), FLAT * 1.5);
  const peaks = useOwn ? data.peak_hours ?? [] : market.peak_hours;
  const quiet = [...bars.keys()].sort((a, b) => bars[a] - bars[b]).slice(0, 3).sort((a, b) => a - b);

  return (
    <div>
      {pool && (
        <p className="mb-2 text-xs leading-5 text-ink-2">
          {useOwn ? (
            <>
              <span className="font-medium text-good">Pola stabil</span> ({data.days} hari, kecocokan dua paruh bulan{" "}
              {fmtNum((data.consistency ?? 0) * 100, 0)}%). Paling ramai {range(peaks)} WIB.
            </>
          ) : (
            <>
              <span className="font-medium text-warning">Pola pool ini belum bisa diandalkan</span>{" "}
              ({data.days ?? 0} hari
              {data.consistency != null ? `, kecocokan ${fmtNum(data.consistency * 100, 0)}%` : ""}). Ditampilkan pola pasar:
              ramai {range(peaks)} WIB.
            </>
          )}
        </p>
      )}
      <div className={`flex items-end gap-[3px] ${compact ? "h-16" : "h-24"}`} role="img" aria-label={`Volume per jam WIB, paling ramai ${range(peaks)}`}>
        {bars.map((v, h) => {
          const isPeak = peaks.includes(h);
          const m = market.profile?.[h];
          return (
            <div
              key={h}
              className="group relative flex h-full flex-1 flex-col justify-end"
              title={`${String(h).padStart(2, "0")}:00 WIB · ${fmtNum(v, 1)}% volume harian${useOwn && m != null ? ` (pasar ${fmtNum(m, 1)}%)` : ""}`}
            >
              <div
                className={`w-full rounded-t-[3px] transition-opacity group-hover:opacity-80 ${
                  isPeak ? "bg-accent" : v >= FLAT ? "bg-accent/45" : "bg-raised"
                } ${h === now ? "ring-1 ring-white/70" : ""}`}
                style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
              />
              {useOwn && m != null && (
                <span className="absolute inset-x-0 h-[2px] rounded bg-[#3ec6e0]/80" style={{ bottom: `${(m / max) * 100}%` }} />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-ink-3">
        {[0, 6, 12, 18, 23].map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}</span>
        ))}
      </div>
      {!compact && (
        <p className="mt-2 text-[11px] leading-5 text-ink-3">
          Sepi {range(quiet)} WIB. Batang terang = 3 jam teramai, garis putih = jam sekarang
          {useOwn ? ", garis biru = pola pasar" : ""}. Fee LP sebanding dengan volume: pastikan posisi in range sebelum jam
          ramai.
        </p>
      )}
    </div>
  );
}
