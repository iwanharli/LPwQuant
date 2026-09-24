import { fmtNum } from "../lib/format";

/** Same threshold the engine's planner refuses to enter on ("Harga sedang pump"). */
export const PUMP_WARN_PCT = 30;

/**
 * Entering a pool right after a sharp rise is what cost this wallet the most: ACAT rose 4x in 90 minutes, the
 * position went in at the top and gave back 57% in 35 minutes. This says so where the entry decision is made.
 */
export default function PumpWarning({ changePct1h, compact = false }: { changePct1h: number | null | undefined; compact?: boolean }) {
  if (changePct1h == null || changePct1h < PUMP_WARN_PCT) return null;
  const pct = `+${fmtNum(changePct1h, 0)}%`;
  if (compact) {
    return (
      <span
        title={`Harga naik ${pct} dalam 1 jam. Masuk LP sekarang berisiko besar: saat harga kembali turun, posisimu otomatis membeli token yang jatuh.`}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-critical/45 bg-critical/10 px-2 py-0.5 text-[11px] font-semibold text-critical"
      >
        ⚠ Sedang pump {pct}/1j
      </span>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-critical/45 bg-critical/[0.08] px-4 py-3">
      <span aria-hidden className="mt-0.5 text-lg leading-none">⚠</span>
      <div className="min-w-0 text-sm">
        <div className="font-semibold text-critical">Jangan masuk sekarang: harga naik {pct} dalam 1 jam</div>
        <p className="mt-1 leading-5 text-ink-2">
          Aturan engine menolak entry di atas +{PUMP_WARN_PCT}%/jam. Saat harga kembali turun, posisi DLMM-mu otomatis membeli token yang
          sedang jatuh dengan SOL/USDC-mu, dan fee jarang menutupnya. Tunggu harga tenang dulu, atau pasang satu sisi SOL/USDC di bawah harga.
        </p>
      </div>
    </div>
  );
}
