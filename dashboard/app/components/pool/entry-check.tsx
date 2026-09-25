import { fmtNum } from "../../lib/format";
import { RISKY_FLAGS, flagMeta } from "../../lib/flags";
import type { PoolRow } from "../../lib/types";
import { PUMP_WARN_PCT } from "../pump-warning";

type Level = "stop" | "warn" | "ok";
type Check = { level: Level; text: string };

const LEVEL = {
  stop: { dot: "bg-rose-400", text: "text-rose-200" },
  warn: { dot: "bg-amber-400", text: "text-amber-100" },
  ok: { dot: "bg-emerald-400", text: "text-ink-2" },
};

/** Every entry check this app knows, in one place, worst first. */
function checks(pool: PoolRow): Check[] {
  const out: Check[] = [];
  const s = (pool.security ?? {}) as NonNullable<PoolRow["security"]>;
  const change = pool.change_pct_1h;
  if (change != null && change >= PUMP_WARN_PCT) out.push({ level: "stop", text: `Sedang pump +${fmtNum(change, 0)}%/1 jam: posisi akan membeli token saat harga turun lagi` });
  else if (change != null && change <= -15) out.push({ level: "stop", text: `Sedang dump ${fmtNum(change, 0)}%/1 jam` });

  if (s.transfer_fee_pct) out.push({ level: s.transfer_fee_pct >= 1 ? "stop" : "warn", text: `Pajak transfer ${s.transfer_fee_pct}%: dipotong tiap masuk, keluar, klaim, dan swap` });
  else if (s.transfer_fee_mutable) out.push({ level: "warn", text: "Pajak transfer 0%, tapi pemilik token masih bisa menaikkannya" });

  for (const f of pool.flags) {
    if (RISKY_FLAGS.has(f) && !["pumping", "dumping", "transfer_fee"].includes(f)) out.push({ level: "stop", text: flagMeta(f).title });
  }
  if (s.cluster_pct != null && s.cluster_pct >= 5) {
    out.push({
      level: s.cluster_pct >= 10 ? "stop" : "warn",
      text: `${s.cluster_size ?? "Beberapa"} wallet saling terhubung memegang ${fmtNum(s.cluster_pct, 1)}% supply`,
    });
  }
  if (s.top10_pct != null && s.top10_pct >= 50) out.push({ level: "warn", text: `Top 10 pemegang ${fmtNum(s.top10_pct, 0)}% supply` });
  if (pool.token_age_hours != null && pool.token_age_hours < 24) out.push({ level: "warn", text: `Token baru (${fmtNum(pool.token_age_hours, 0)} jam): harga belum punya riwayat` });
  if (!pool.security) out.push({ level: "warn", text: "Cek keamanan RugCheck belum selesai" });

  const best = pool.best;
  if (best) {
    out.push(
      best.enter
        ? { level: "ok", text: `Profil ${best.label} (terbaik di uji paper) akan masuk${best.coverage != null ? `: fee menutup biaya ${fmtNum(best.coverage, 1)}×` : ""}` }
        : { level: "warn", text: `Profil ${best.label} tidak masuk: ${best.reason ?? "tidak lolos aturannya"}` },
    );
  }
  const order: Record<Level, number> = { stop: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

export default function EntryCheck({ pool }: { pool: PoolRow }) {
  const list = checks(pool);
  const stops = list.filter((c) => c.level === "stop").length;
  const warns = list.filter((c) => c.level === "warn").length;
  const verdict: { label: string; cls: string; hint: string } = stops
    ? { label: "Jangan masuk dulu", cls: "border-rose-400/40 bg-rose-500/[0.08] text-rose-200", hint: `${stops} tanda bahaya` }
    : warns
      ? { label: "Boleh, dengan hati-hati", cls: "border-amber-400/40 bg-amber-500/[0.08] text-amber-100", hint: `${warns} hal perlu diperhatikan` }
      : { label: "Layak masuk", cls: "border-emerald-400/40 bg-emerald-500/[0.08] text-emerald-200", hint: "tidak ada tanda bahaya dari data yang dicek" };

  return (
    <section className={`rounded-2xl border p-4 ${verdict.cls}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">{verdict.label}</h2>
        <span className="text-xs opacity-80">{verdict.hint}</span>
      </div>
      {list.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {list.map((c) => (
            <li key={c.text} className="flex gap-2 text-xs leading-5">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL[c.level].dot}`} aria-hidden />
              <span className={LEVEL[c.level].text}>{c.text}</span>
            </li>
          ))}
        </ul>
      )}
      <a
        href={`https://app.meteora.ag/dlmm/${pool.address}`}
        target="_blank"
        rel="noreferrer"
        className={`mt-4 block rounded-xl px-3 py-2 text-center text-sm font-semibold ${
          stops ? "border border-rose-400/40 text-rose-200 hover:bg-rose-500/10" : "btn-accent"
        }`}
      >
        {stops ? "Tetap buka di Meteora ↗" : "Buka di Meteora ↗"}
      </a>
    </section>
  );
}
