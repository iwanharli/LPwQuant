"use client";

import { useEffect, useState } from "react";
import { CLAIM_URL, ENGINE_URL, fmtNum, fmtSignedPct, usd } from "../../lib/format";
import { StatusDot } from "../ui";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RENT_PER_ACCOUNT_SOL = 0.00203928; // rent-exempt deposit of one SPL token account, returned when it is closed

type Quote = { out_amount: number; out_usd: number; cost_pct: number; route: string[] } | null;
type Suggestion = {
  mint: string;
  symbol: string;
  amount: number;
  value_usd: number;
  change_24h: number | null;
  verified: boolean;
  organic_score: number | null;
  to_sol: Quote;
  to_usdc: Quote;
};

type Verdict = { label: string; severity: "good" | "warning" | "critical"; reasons: string[]; target: "SOL" | "USDC" };

/**
 * Plain-language advice for one coin. SOL and USDC are the user's core assets, so the default is to swap back;
 * what can argue against it is the cost of the swap, and a sharp fall that selling would lock in.
 */
function advise(s: Suggestion, lpTokens: Set<string>): Verdict {
  const sol = s.to_sol;
  const usdc = s.to_usdc;
  const target: "SOL" | "USDC" = !sol ? "USDC" : !usdc ? "SOL" : usdc.out_usd > sol.out_usd * 1.002 ? "USDC" : "SOL";
  const q = target === "SOL" ? sol : usdc;
  const reasons: string[] = [];
  if (lpTokens.has(s.symbol)) reasons.push(`Kemungkinan hasil claim fee dari posisi LP ${s.symbol}. Tukar untuk mengunci hasilnya.`);
  if (s.change_24h != null && s.change_24h >= 20)
    reasons.push(`Naik ${fmtSignedPct(s.change_24h, 0)} dalam 24 jam: memecoin yang melonjak sering turun lagi, ini waktu yang baik untuk menjual.`);
  if (s.change_24h != null && s.change_24h <= -20)
    reasons.push(`Turun ${fmtSignedPct(s.change_24h, 0)} dalam 24 jam: menjual sekarang merealisasikan rugi. Tetap jual kalau tidak yakin koin ini pulih.`);
  if (!s.verified) reasons.push("Token belum terverifikasi Jupiter: risiko menahannya lebih besar.");
  if (s.organic_score != null && s.organic_score < 40) reasons.push("Organic score rendah: sebagian besar aktivitasnya bot.");

  if (!q) return { label: "Tidak ada rute", severity: "critical", reasons: ["Jupiter tidak menemukan rute swap saat ini."], target };
  if (q.cost_pct >= 10)
    return { label: "Tunda", severity: "critical", reasons: [`Biaya swap ${fmtNum(q.cost_pct, 1)}%: likuiditas terlalu tipis sekarang.`, ...reasons], target };
  if (q.cost_pct >= 3 || (s.change_24h != null && s.change_24h <= -20))
    return {
      label: "Pertimbangkan",
      severity: "warning",
      reasons: [
        ...(q.cost_pct >= 3
          ? [`Biaya swap ${fmtNum(q.cost_pct, 1)}% (≈ ${usd.format(s.value_usd - q.out_usd)}), biasanya karena fee dinamis pool sedang tinggi. Bisa ditunggu sampai lebih murah.`]
          : []),
        ...reasons,
      ],
      target,
    };
  return { label: "Disarankan swap", severity: "good", reasons: reasons.length ? reasons : ["Bukan aset utama. Tukar ke aset utama untuk mengurangi risiko."], target };
}

const SEVERITY_CHIP = {
  good: "border-good/35 bg-good/10 text-good",
  warning: "border-warning/35 bg-warning/10 text-warning",
  critical: "border-critical/40 bg-critical/10 text-critical",
} as const;

function QuoteBox({ label, q, best }: { label: string; q: Quote; best: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${best ? "border-accent/45 bg-accent/5" : "border-line bg-black/20"}`}>
      <div className="flex items-center justify-between text-[11px] text-ink-3">
        <span>Ke {label}</span>
        {best && <span className="font-medium text-accent">terbaik</span>}
      </div>
      {q ? (
        <>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-ink">
            {fmtNum(q.out_amount, label === "SOL" ? 4 : 2)} {label}
          </div>
          <div className="text-[11px] tabular-nums text-ink-3">
            ≈ {usd.format(q.out_usd)} · biaya {fmtNum(q.cost_pct, 1)}% · {q.route.join(" → ")}
          </div>
        </>
      ) : (
        <div className="mt-0.5 text-sm text-ink-3">Tidak ada rute</div>
      )}
    </div>
  );
}

export default function SwapSuggestions({ owner, dustCount }: { owner: string; dustCount: number }) {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [lpTokens, setLpTokens] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [sug, pf] = await Promise.all([
          fetch(`${CLAIM_URL}/swap-suggestions?owner=${owner}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
          fetch(`${ENGINE_URL}/api/portfolio?wallet=${owner}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        if (cancelled) return;
        setItems(sug.suggestions as Suggestion[]);
        setFailed(false);
        const names = ((pf?.pools ?? []) as { token_x: string }[]).map((p) => p.token_x);
        setLpTokens(new Set(names));
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [owner]);

  const rentSol = dustCount * RENT_PER_ACCOUNT_SOL;
  if (failed && !items) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97] shadow-[0_14px_42px_rgba(0,0,0,0.20)] backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Saran swap ke aset utama</h2>
        <span className="text-xs text-ink-3">Aset utama: SOL dan USDC · quote dari Jupiter, belum termasuk slippage</span>
      </div>

      {!items ? (
        <p className="px-4 py-6 text-sm text-ink-3">Mengambil quote…</p>
      ) : items.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-5 text-sm text-ink-2">
          <StatusDot severity="good" /> Semua koin bernilai ≥ $1 sudah dalam SOL atau USDC.
        </p>
      ) : (
        <div className="divide-y divide-line/70">
          {items.map((s) => {
            const v = advise(s, lpTokens);
            const out = v.target === "SOL" ? SOL_MINT : USDC_MINT;
            return (
              <div key={s.mint} className="grid gap-4 px-4 py-4 lg:grid-cols-[1.2fr_1.6fr_auto] lg:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-ink">{s.symbol}</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${SEVERITY_CHIP[v.severity]}`}>
                      <StatusDot severity={v.severity} />
                      {v.label}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs tabular-nums text-ink-3">
                    {fmtNum(s.amount, 2)} {s.symbol} · {usd.format(s.value_usd)}
                    {s.change_24h != null && (
                      <span className={s.change_24h >= 0 ? "text-up" : "text-down"}> · {fmtSignedPct(s.change_24h, 1)} 24j</span>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-ink-2">
                    {v.reasons.map((r) => (
                      <li key={r} className="flex gap-2">
                        <span className="text-ink-3">•</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <QuoteBox label="SOL" q={s.to_sol} best={v.target === "SOL"} />
                  <QuoteBox label="USDC" q={s.to_usdc} best={v.target === "USDC"} />
                </div>
                <a
                  href={`https://jup.ag/swap/${s.mint}-${out}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-accent/45 bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20"
                >
                  Swap ke {v.target} di Jupiter ↗
                </a>
              </div>
            );
          })}
        </div>
      )}

      {dustCount > 0 && (
        <div className="border-t border-line bg-black/20 px-4 py-3 text-xs leading-5 text-ink-3">
          <span className="font-medium text-ink-2">Debu ({dustCount} koin):</span> nilainya terlalu kecil untuk di-swap,
          biayanya lebih besar dari hasilnya. Tapi setiap akun token menahan deposit sewa sekitar{" "}
          {RENT_PER_ACCOUNT_SOL} SOL, jadi menutup akun-akun itu (burn lalu close, misalnya lewat Sol Incinerator) bisa
          mengembalikan sekitar <span className="text-ink-2">{fmtNum(rentSol, 3)} SOL</span>.
        </div>
      )}
    </section>
  );
}
