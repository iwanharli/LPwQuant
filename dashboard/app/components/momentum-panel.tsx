"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL } from "../lib/format";

type Variant = {
  label: string;
  signal: string;
  target_pct: number;
  stop_pct: number;
  max_hold_hours: number;
  trades: number;
  pools?: number;
  mean_net_pct?: number;
  ci_low?: number;
  ci_high?: number;
  median_net_pct?: number;
  win_rate_pct?: number;
  best_pct?: number;
  worst_pct?: number;
  p10_pct?: number;
  mean_cost_pct?: number;
  mean_hold_hours?: number;
  exit_reasons?: Record<string, number>;
  hold_mean_net_pct?: number;
  hold_ci_low?: number;
  hold_ci_high?: number;
  edge_vs_hold?: number;
};

type Run = { run_at: number | null; hours: number | null; results: Variant[] };

const pct = (v: number | undefined, digits = 2) =>
  v === undefined || v === null || Number.isNaN(v) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;

/** A variant only counts as an edge when the whole interval sits above zero. */
function verdict(v: Variant): { text: string; tone: "good" | "bad" | "none" } {
  if (!v.trades) return { text: "tidak ada trade", tone: "none" };
  if ((v.ci_low ?? 0) > 0) return { text: "positif", tone: "good" };
  if ((v.ci_high ?? 0) < 0) return { text: "rugi", tone: "bad" };
  return { text: "tidak terbukti", tone: "none" };
}

const TONE: Record<string, string> = {
  good: "text-up",
  bad: "text-down",
  none: "text-ink-3",
};

export default function MomentumPanel() {
  const [run, setRun] = useState<Run | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/momentum`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Run;
        if (!cancelled) {
          setRun(body);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <Card>Engine tidak bisa dihubungi.</Card>;
  }
  if (!run) {
    return <Card>Memuat…</Card>;
  }
  if (!run.results.length) {
    return (
      <Card>
        Belum ada hasil tersimpan. Jalankan di folder <code className="text-ink-2">engine</code>:
        <div className="mt-2 rounded-lg border border-line bg-bg/60 px-3 py-2 font-mono text-xs text-ink-2">
          uv run python -m app.momentum --hours 720 --save
        </div>
      </Card>
    );
  }

  const best = run.results.reduce((a, b) => ((b.mean_net_pct ?? -99) > (a.mean_net_pct ?? -99) ? b : a));
  const anyEdge = run.results.some((v) => (v.ci_low ?? 0) > 0);

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink">Kesimpulan</h2>
          <span className="text-xs text-ink-3">
            {run.hours ? `${Math.round(run.hours / 24)} hari data` : ""}
            {run.run_at
              ? ` · dijalankan ${new Date(run.run_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`
              : ""}
          </span>
        </div>
        <p className="mt-2 text-sm leading-6 text-ink-2">
          {anyEdge ? (
            <>
              Ada varian yang seluruh selang kepercayaannya di atas nol. Itu belum bukti final: setelannya dipilih
              dari data yang sama, jadi perlu diuji maju sebelum dipercaya.
            </>
          ) : (
            <>
              Tidak ada satu pun varian yang selang kepercayaannya seluruhnya di atas nol. Varian terbaik,{" "}
              <span className="text-ink">{best.label}</span>, menghasilkan {pct(best.mean_net_pct, 3)} per trade
              dengan selang [{pct(best.ci_low)}, {pct(best.ci_high)}] — masih memuat nol, artinya belum bisa
              dibedakan dari keberuntungan.
            </>
          )}
        </p>
      </Card>

      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
                <Th className="pl-4">Varian</Th>
                <Th right>Trade</Th>
                <Th right>Pool</Th>
                <Th right>Rata-rata bersih</Th>
                <Th right>95% CI</Th>
                <Th right>Win</Th>
                <Th right>Biaya</Th>
                <Th right>Tahan saja</Th>
                <Th right>Selisih</Th>
                <Th right className="pr-4">Vonis</Th>
              </tr>
            </thead>
            <tbody>
              {run.results.map((v) => {
                const ver = verdict(v);
                return (
                  <tr key={v.label} className="border-b border-line/60 last:border-0">
                    <td className="py-3 pl-4">
                      <div className="font-medium text-ink">{v.label}</div>
                      <div className="text-[11px] text-ink-3">
                        target +{v.target_pct}% · stop {v.stop_pct}% · maks {v.max_hold_hours}j
                      </div>
                    </td>
                    <Td right>{v.trades || "–"}</Td>
                    <Td right>{v.pools ?? "–"}</Td>
                    <Td right className={(v.mean_net_pct ?? 0) > 0 ? "text-up" : "text-down"}>
                      {pct(v.mean_net_pct, 3)}
                    </Td>
                    <Td right className="tabular-nums text-ink-3">
                      {v.trades ? `[${pct(v.ci_low)}, ${pct(v.ci_high)}]` : "–"}
                    </Td>
                    <Td right>{v.win_rate_pct !== undefined ? `${v.win_rate_pct}%` : "–"}</Td>
                    <Td right className="text-ink-3">{pct(v.mean_cost_pct, 3)}</Td>
                    <Td right className="text-ink-3">{pct(v.hold_mean_net_pct, 3)}</Td>
                    <Td right className={(v.edge_vs_hold ?? 0) > 0 ? "text-up" : "text-ink-3"}>
                      {pct(v.edge_vs_hold, 3)}
                    </Td>
                    <Td right className={`pr-4 ${TONE[ver.tone]}`}>{ver.text}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-ink">Cara uji ini dibuat jujur</h2>
        <ul className="mt-2 space-y-1.5 text-sm leading-6 text-ink-2">
          <li>
            <span className="text-ink">Isi order hanya di harga penutupan candle.</span> Memakai high/low intrabar
            untuk memutuskan target tersentuh akan memberi bot harga yang tidak mungkin ia lihat lebih dulu.
          </li>
          <li>
            <span className="text-ink">Biaya dua kali.</span> Fee pool dan price impact dibebankan saat beli dan
            saat jual, dari model biaya yang sama dengan sisi LP.
          </li>
          <li>
            <span className="text-ink">Ada kontrol.</span> Kolom &quot;tahan saja&quot; membeli token yang sama di
            saat yang sama lalu menahannya sampai batas waktu, tanpa target dan stop.
          </li>
          <li>
            <span className="text-ink">CI di-bootstrap per pool</span>, bukan per trade: beberapa trade di satu
            pool bukan sampel yang saling bebas.
          </li>
          <li>
            <span className="text-ink">Yang tidak tertangkap backtest:</span> sandwich/MEV, token yang tidak bisa
            dijual, pajak jual, dan likuiditas yang hilang tepat saat ingin keluar. Semuanya memperburuk hasil
            nyata, tidak pernah memperbaikinya.
          </li>
        </ul>
      </Card>
    </div>
  );
}

function Card({ children, padded = true }: { children: React.ReactNode; padded?: boolean }) {
  return (
    <section className={`rounded-2xl border border-line bg-raised/40 ${padded ? "p-4 sm:p-5" : "py-1"}`}>
      {children}
    </section>
  );
}

function Th({ children, right, className = "" }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <th className={`py-2.5 font-medium ${right ? "text-right" : ""} ${className}`}>{children}</th>;
}

function Td({ children, right, className = "" }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={`py-3 tabular-nums ${right ? "text-right" : ""} ${className}`}>{children}</td>;
}
