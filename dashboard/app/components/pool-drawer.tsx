"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { STRATEGY_LABEL, flagMeta, sortFlags } from "../lib/flags";
import { REGIME_META, TIER_META } from "../lib/flags";
import {
  BINS_PER_POSITION,
  binAlignedRange,
  binStepPct,
  fmtPriceExact,
  compact,
  fmtAge,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtSignedPct,
  fmtTime,
  integer,
  positionSpanPct,
  shortAddress,
  usd,
  usdCompact,
} from "../lib/format";
import PumpWarning from "./pump-warning";
import { isActivePlan, type ActivePlan, type PoolRow, type RiskyRange } from "../lib/types";
import { AlertIcon, CandleIcon, CheckIcon, CloseIcon, CopyIcon, ExitIcon, ExternalLinkIcon, ShieldIcon } from "./icons";
import BusyHours from "./busy-hours";
import { Delta, Meter, PlanBadge, RegimeBadge, StatusDot, TokenAvatar } from "./ui";

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-white/[0.06] px-5 py-4">
      <h3 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-bg/55 px-3 py-2 shadow-inner shadow-black/10">
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums text-ink">{children}</dd>
    </div>
  );
}

/** Price range relative to entry: band = liquidity, marker = current price. */
function RangeBar({ low, high }: { low: number; high: number }) {
  const span = Math.max(Math.abs(low), Math.abs(high), 5) * 1.3;
  const toPct = (v: number) => ((v + span) / (2 * span)) * 100;
  return (
    <div className="pt-6">
      <div className="relative h-2 rounded-full bg-line">
        <div
          className="absolute inset-y-0 rounded-full bg-accent/70"
          style={{ left: `${toPct(low)}%`, width: `${toPct(high) - toPct(low)}%` }}
        />
        <div className="absolute -top-1 bottom-[-4px] w-0.5 rounded bg-ink" style={{ left: `${toPct(0)}%` }}>
          <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-ink-2">Harga</span>
        </div>
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] tabular-nums text-ink-3">
        <span className="absolute -translate-x-1/2" style={{ left: `${toPct(low)}%` }}>
          {low}%
        </span>
        {high > 0 && (
          <span className="absolute -translate-x-1/2" style={{ left: `${toPct(high)}%` }}>
            +{high}%
          </span>
        )}
      </div>
    </div>
  );
}

function PriceField({ label, value, hint }: { label: string; value: number; hint: string }) {
  const [copied, setCopied] = useState(false);
  const text = fmtPriceExact(value);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="rounded-xl border border-white/[0.08] bg-bg/55 px-3 py-2 shadow-inner shadow-black/10">
      <div className="flex items-center justify-between text-[11px] text-ink-3">
        <span>{label}</span>
        <button onClick={copy} aria-label={`Salin ${label}`} className="text-ink-3 transition-colors hover:text-ink">
          {copied ? <CheckIcon width={12} height={12} /> : <CopyIcon width={12} height={12} />}
        </button>
      </div>
      <div className="mt-0.5 font-mono text-[13px] font-medium tabular-nums text-ink">{text}</div>
      <div className="text-[11px] text-ink-3">{hint}</div>
    </div>
  );
}

function PlanSection({
  plan,
  binStep,
  price,
  quote,
}: {
  plan: ActivePlan;
  binStep: number;
  price: number;
  quote: string;
}) {
  const range = binAlignedRange(price, binStep, plan.range_low_pct, plan.range_high_pct);
  return (
    <Section title="Rencana posisi">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">{STRATEGY_LABEL[plan.strategy]}</div>
          <div className="text-xs text-ink-3">{plan.side === "quote" ? "Satu sisi, SOL/USDC saja" : "Dua sisi"}</div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">{usd.format(plan.size_usd)}</div>
          <div className="text-xs text-ink-3">
            {plan.size_pct}% portofolio · tier {TIER_META[plan.tier].short.toLowerCase()}
          </div>
        </div>
      </div>
      <p className="mt-3 text-sm text-ink-2">{plan.note}</p>
      <RangeBar low={plan.range_low_pct} high={plan.range_high_pct} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <PriceField
          label={`Min price (${quote})`}
          value={range.min}
          hint={`${((range.min / price - 1) * 100).toFixed(1)}% · ${range.below} bin di bawah`}
        />
        <PriceField
          label={`Max price (${quote})`}
          value={range.max}
          hint={`+${((range.max / price - 1) * 100).toFixed(1)}% · ${range.above} bin di atas`}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-ink-3">
        Dari harga sekarang {fmtPriceExact(price)} {quote}, dibulatkan ke bin penuh. Cek ulang harga di Meteora sebelum
        memasang posisi.
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Bin">{plan.bins}</Stat>
        <Stat label="Posisi">{plan.positions}</Stat>
        <Stat label={`1 posisi (${BINS_PER_POSITION} bin)`}>≈ {positionSpanPct(binStep).toFixed(1)}%</Stat>
        <Stat label="Fee / hari">{usd.format(plan.expected_fee_usd_day)}</Stat>
        {plan.new_bin_arrays != null && (
          <Stat label="Bin array baru">
            {plan.new_bin_arrays === 0 ? "0" : `${plan.new_bin_arrays} (≈${(plan.new_bin_arrays * 0.0714).toFixed(3)} SOL)`}
          </Stat>
        )}
      </dl>
      {plan.positions > 1 && (
        <p className="mt-2 text-xs text-ink-3">
          Range {(plan.range_high_pct - plan.range_low_pct).toFixed(1)}% dengan bin step {binStep} ({binStepPct(binStep)}
          /bin) butuh {plan.bins} bin, jadi dibagi ke {plan.positions} posisi (rent dan transaksi bertambah).
        </p>
      )}
      {(plan.size_capped_by_tvl || plan.reason || plan.notes.length > 0) && (
        <ul className="mt-3 space-y-1 text-xs text-ink-2">
          {plan.notes.map((n) => (
            <li key={n} className="flex items-center gap-2">
              <StatusDot severity="info" /> {n}
            </li>
          ))}
          {plan.size_capped_by_tvl && (
            <li className="flex items-center gap-2">
              <StatusDot severity="warning" /> Ukuran dibatasi 2% dari TVL pool
            </li>
          )}
          {plan.reason && (
            <li className="flex items-center gap-2">
              <StatusDot severity="info" /> {plan.reason}
            </li>
          )}
        </ul>
      )}
    </Section>
  );
}

/** The range offered for a pool the plan holds back, for entering anyway at the user's own risk. */
function RiskyPlanSection({
  risky,
  reason,
  binStep,
  price,
  quote,
}: {
  risky: RiskyRange;
  reason: string;
  binStep: number;
  price: number;
  quote: string;
}) {
  const range = binAlignedRange(price, binStep, risky.range_low_pct, risky.range_high_pct);
  return (
    <section className="rounded-2xl border border-amber-400/35 bg-amber-400/[0.04] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">Range risiko tinggi</h3>
          <div className="mt-1 text-lg font-semibold">{STRATEGY_LABEL[risky.strategy]}</div>
          <div className="text-xs text-ink-3">{risky.side === "quote" ? "Satu sisi, SOL/USDC saja" : "Dua sisi"}</div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">maks {usd.format(risky.size_usd)}</div>
          <div className="text-xs text-ink-3">¼ ukuran normal</div>
        </div>
      </div>
      <p className="mt-3 text-sm text-ink-2">{risky.note}</p>
      <RangeBar low={risky.range_low_pct} high={risky.range_high_pct} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <PriceField
          label={`Min price (${quote})`}
          value={range.min}
          hint={`${((range.min / price - 1) * 100).toFixed(1)}% · ${range.below} bin di bawah`}
        />
        <PriceField
          label={`Max price (${quote})`}
          value={range.max}
          hint={`+${((range.max / price - 1) * 100).toFixed(1)}% · ${range.above} bin di atas`}
        />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="Bin">{risky.bins}</Stat>
        <Stat label="Posisi">{risky.positions}</Stat>
        <Stat label="Cut loss">−{risky.stop_loss_pct}%</Stat>
      </dl>
      <ul className="mt-3 space-y-1 text-xs text-ink-2">
        <li className="flex items-center gap-2">
          <StatusDot severity="warning" /> Tidak direkomendasikan: {reason}
        </li>
        <li className="flex items-center gap-2">
          <StatusDot severity="info" /> Tutup begitu PnL Meteora ≥ +5% atau rugi mencapai batas cut loss.
        </li>
      </ul>
    </section>
  );
}

function ExitSection({ plan }: { plan: ActivePlan }) {
  const { breakout_below_pct: below, breakout_above_pct: above } = plan.exit;
  const rules = [
    ["Stop loss", `PnL total (nilai + fee) ≤ −${plan.exit.stop_loss_pct}%`],
    ["Keluar range", `Lebih dari ${plan.exit.out_of_range_minutes} menit`],
    ...(below != null || above != null
      ? [["Breakout Donchian", `Harga ${below != null ? `< ${below}%` : ""}${below != null && above != null ? " atau " : ""}${above != null ? `> +${above}%` : ""}`]]
      : []),
    ["Fee melemah", `Laju fee < ${plan.exit.fee_decay_ratio * 100}% dari saat entry`],
    ["Batas waktu", `Maksimal ${plan.exit.max_hold_hours} jam`],
  ];
  return (
    <Section title="Aturan exit" icon={<ExitIcon width={13} height={13} />}>
      <dl className="divide-y divide-line rounded-xl border border-white/[0.08]">
        {rules.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
            <dt className="text-ink-3">{label}</dt>
            <dd className="text-right text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function FlowBar({ ratio, label }: { ratio: number; label: string }) {
  const buy = Math.round(ratio * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px] text-ink-3">
        <span>
          {label}: beli <span className="tabular-nums text-ink-2">{buy}%</span>
        </span>
        <span>
          jual <span className="tabular-nums text-ink-2">{100 - buy}%</span>
        </span>
      </div>
      <div className="flex h-1.5 gap-[2px] overflow-hidden rounded-full">
        <span className="rounded-l-full bg-up/80" style={{ width: `${buy}%` }} />
        <span className="flex-1 rounded-r-full bg-down/70" />
      </div>
    </div>
  );
}

function IndicatorSection({ row }: { row: PoolRow }) {
  const m = row.market;
  if (!m || m.candles == null) {
    return (
      <Section title="Indikator teknikal">
        <p className="text-sm text-ink-3">Menunggu data candle 30m…</p>
      </Section>
    );
  }
  const regime = m.regime ? REGIME_META[m.regime] : null;
  return (
    <Section title={`Indikator teknikal · candle 30m (${m.candles})`}>
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-bg/55 px-3 py-2.5 shadow-inner shadow-black/10">
        <RegimeBadge regime={m.regime} />
        <span className="text-right text-xs text-ink-3">{regime?.hint ?? "Belum cukup candle untuk ADX"}</span>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="ADX 14">
          {fmtNum(m.adx)}{" "}
          <span className="text-xs font-normal text-ink-3">
            +{fmtNum(m.plus_di)} / −{fmtNum(m.minus_di)}
          </span>
        </Stat>
        <Stat label="Choppiness 14">{fmtNum(m.choppiness)}</Stat>
        <Stat label="RSI 14">{fmtNum(m.rsi)}</Stat>
        <Stat label="ATR 14">{fmtPct(m.atr_pct, 2)}</Stat>
        <Stat label="Lebar Bollinger">
          {fmtPct(m.bb_width_pct)}
          {m.bb_squeeze && <span className="ml-1 text-xs font-normal text-warning">squeeze</span>}
        </Stat>
        <Stat label="Slope EMA 20">{fmtSignedPct(m.ema_slope_pct, 2)}</Stat>
        <Stat label="Donchian bawah">{fmtSignedPct(m.donchian_low_pct)}</Stat>
        <Stat label="Donchian atas">{fmtSignedPct(m.donchian_high_pct)}</Stat>
        <Stat label="Drawdown 24j">{fmtSignedPct(m.drawdown_pct)}</Stat>
      </dl>

      <div className="mt-4 space-y-3 rounded-xl border border-white/[0.08] bg-bg/55 px-3 py-3 shadow-inner shadow-black/10">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-ink-2">Arus transaksi</span>
          {m.buy_ratio_h1 != null ? (
            <span className="flex items-center gap-2 text-ink-3">
              {m.sell_pressure && (
                <span className="flex items-center gap-1.5 text-ink-2">
                  <StatusDot severity="warning" /> Tekanan jual
                </span>
              )}
              <span className="tabular-nums">{integer.format(m.txns_h1 ?? 0)} tx/jam</span>
            </span>
          ) : (
            <span className="text-ink-3">Belum ada data</span>
          )}
        </div>
        {m.buy_ratio_h1 != null && <FlowBar ratio={m.buy_ratio_h1} label="1 jam" />}
        {m.buyer_ratio_h1 != null && <FlowBar ratio={m.buyer_ratio_h1} label="Wallet unik" />}
        {m.buy_ratio_m15 != null && <FlowBar ratio={m.buy_ratio_m15} label="15 menit" />}
      </div>
    </Section>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5 text-sm">
      <span
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${
          ok ? "bg-good/20 text-up" : "bg-critical/20 text-down"
        }`}
      >
        {ok ? <CheckIcon width={11} height={11} strokeWidth={2.5} /> : <AlertIcon width={11} height={11} strokeWidth={2.5} />}
      </span>
      <span className="flex-1 text-ink-2">{label}</span>
      {detail && <span className="tabular-nums text-ink">{detail}</span>}
    </li>
  );
}

const TAG_LABELS = {
  bundler: "Bundler",
  sniper: "Sniper",
  smart_degen: "Smart money",
  renowned: "KOL",
} as const;

function InsiderSection({ row }: { row: PoolRow }) {
  const i = row.insights;
  if (!i) {
    return (
      <Section title="Insider & dev · GMGN">
        <p className="text-sm text-ink-3">Menunggu data GMGN…</p>
      </Section>
    );
  }
  const dev = i.dev;
  const buy = i.flow?.buy_usd_1h ?? null;
  const sell = i.flow?.sell_usd_1h ?? null;
  const tagEntries = (Object.keys(TAG_LABELS) as (keyof typeof TAG_LABELS)[]).filter((t) => i.tags[t]);
  const updated = Math.max(i.info_at ?? 0, i.holders_at ?? 0);
  return (
    <Section title="Insider & dev · GMGN">
      {dev && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Token dibuat dev">{dev.launches != null ? integer.format(dev.launches) : "–"}</Stat>
          <Stat label="Dev memegang">{fmtPct(dev.hold_pct, 2)}</Stat>
          <Stat label="Sumber dana dev">{dev.fund_from ?? "–"}</Stat>
          <Stat label="Status dev">{dev.status?.replace(/_/g, " ") ?? "–"}</Stat>
          <Stat label="Community takeover">{dev.cto ? "Ya" : "Tidak"}</Stat>
          <Stat label="Boost DexScreener">
            {dev.boost_ts ? `${fmtTime(dev.boost_ts * 1000, false)} WIB` : "Tidak ada"}
          </Stat>
        </dl>
      )}

      {buy != null && sell != null && buy + sell > 0 && (
        <div className="mt-3 rounded-xl border border-white/[0.08] bg-bg/55 px-3 py-3 shadow-inner shadow-black/10">
          <FlowBar ratio={buy / (buy + sell)} label={`Volume USD 1 jam (${usdCompact.format(buy + sell)})`} />
        </div>
      )}

      {tagEntries.length > 0 ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.08]">
          <table className="w-full text-sm">
            <thead className="bg-bg/60 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Jenis wallet</th>
                <th className="px-3 py-2 text-right font-medium">Wallet</th>
                <th className="px-3 py-2 text-right font-medium">% supply</th>
                <th className="px-3 py-2 text-right font-medium">Netflow</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {tagEntries.map((tag) => {
                const s = i.tags[tag]!;
                return (
                  <tr key={tag} className="border-t border-line">
                    <td className="px-3 py-2 text-ink-2">{TAG_LABELS[tag]}</td>
                    <td className="px-3 py-2 text-right text-ink">{integer.format(s.count)}</td>
                    <td className="px-3 py-2 text-right text-ink">{fmtPct(s.holding_pct, 1)}</td>
                    <td className={`px-3 py-2 text-right ${s.netflow_usd < 0 ? "text-down" : "text-ink"}`}>
                      {s.netflow_usd < 0 ? "−" : ""}
                      {usdCompact.format(Math.abs(s.netflow_usd))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-3">Data holder per jenis wallet belum diambil (hanya top pool, tiap 2 jam).</p>
      )}
      {updated > 0 && <p className="mt-3 text-[11px] text-ink-3">Diperbarui {fmtTime(updated, false)} WIB via GMGN</p>}
    </Section>
  );
}

function OrganicSection({ row }: { row: PoolRow }) {
  const o = row.organic;
  if (!o) {
    return (
      <Section title="Aktivitas organik · Jupiter">
        <p className="text-sm text-ink-3">Menunggu data Jupiter…</p>
      </Section>
    );
  }
  const organicVolume = (o.organic_buy_usd_24h ?? 0) + (o.organic_sell_usd_24h ?? 0);
  const totalVolume = (o.buy_usd_24h ?? 0) + (o.sell_usd_24h ?? 0);
  const label = o.organic_label === "high" ? "Tinggi" : o.organic_label === "medium" ? "Sedang" : o.organic_label === "low" ? "Rendah" : "–";
  return (
    <Section title="Aktivitas organik · Jupiter">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Organic score">
          {o.organic_score != null ? `${o.organic_score.toFixed(0)} / 100` : "–"} · {label}
        </Stat>
        <Stat label="Volume organik 24j">
          {totalVolume > 0 ? `${usdCompact.format(organicVolume)} (${fmtPct((organicVolume / totalVolume) * 100, 1)})` : "–"}
        </Stat>
        <Stat label="Pembeli organik 24j">
          {o.organic_buyers_24h != null ? integer.format(o.organic_buyers_24h) : "–"}
          {o.traders_24h != null ? ` / ${integer.format(o.traders_24h)} trader` : ""}
        </Stat>
        <Stat label="Bot holder">{fmtPct(o.bot_holders_pct, 2)}</Stat>
        <Stat label="Top holder">{fmtPct(o.top_holders_pct, 1)}</Stat>
        <Stat label="Terverifikasi">{o.verified ? "Ya" : "Tidak"}</Stat>
      </dl>
      <p className="mt-3 text-[11px] text-ink-3">
        Porsi volume organik biasanya kecil bahkan untuk token sehat (definisi Jupiter sempit); yang dinilai adalah
        skornya. Diperbarui {fmtTime(o.fetched_at, false)} WIB.
      </p>
    </Section>
  );
}

function PumpSection({ row }: { row: PoolRow }) {
  const p = row.pump;
  if (!p || !p.found) return null;
  const now = row.updated_at ?? p.fetched_at;
  const ageDays = p.created_ts ? (now - p.created_ts) / 86_400_000 : null;
  const belowAth =
    p.ath_market_cap_usd && p.usd_market_cap ? (1 - p.usd_market_cap / p.ath_market_cap_usd) * 100 : null;
  const meteoraShare =
    p.pumpswap_liquidity_usd && row.tvl > 0 ? (row.tvl / (row.tvl + p.pumpswap_liquidity_usd)) * 100 : null;
  return (
    <Section title="pump.fun">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Umur token">{ageDays != null ? (ageDays < 2 ? `${(ageDays * 24).toFixed(0)} jam` : `${ageDays.toFixed(0)} hari`) : "–"}</Stat>
        <Stat label="Graduated">{p.complete == null ? "–" : p.complete ? "Ya" : "Belum"}</Stat>
        <Stat label="Disembunyikan pump.fun">{p.is_banned ? "Ya" : "Tidak"}</Stat>
        <Stat label="Market cap">{p.usd_market_cap != null ? usdCompact.format(p.usd_market_cap) : "–"}</Stat>
        <Stat label="ATH market cap">
          {p.ath_market_cap_usd != null ? usdCompact.format(p.ath_market_cap_usd) : "–"}
          {belowAth != null && belowAth > 0 ? ` (−${belowAth.toFixed(0)}%)` : ""}
        </Stat>
        <Stat label="Likuiditas PumpSwap">
          {p.pumpswap_liquidity_usd != null ? usdCompact.format(p.pumpswap_liquidity_usd) : "–"}
          {meteoraShare != null ? ` · Meteora ${meteoraShare.toFixed(0)}%` : ""}
        </Stat>
      </dl>
      <p className="mt-3 text-[11px] text-ink-3">
        Data dari API publik pump.fun (tidak resmi). Diperbarui {fmtTime(p.fetched_at, false)} WIB.
      </p>
    </Section>
  );
}

function SecuritySection({ row }: { row: PoolRow }) {
  const s = row.security;
  const issuer = row.flags.includes("issuer_controlled");
  return (
    <Section title={`Keamanan ${row.base_symbol ?? "token"}`} icon={<ShieldIcon width={13} height={13} />}>
      <div className="mb-3 flex items-center justify-between rounded-xl border border-white/[0.08] bg-bg/55 px-3 py-2.5 shadow-inner shadow-black/10">
        <span className="text-sm text-ink-2">Skor keamanan</span>
        <span className="flex items-center gap-3">
          <Meter value={row.safety} max={30} width="w-24" />
          <span className="w-12 text-right text-sm font-semibold tabular-nums">{row.safety.toFixed(0)}/30</span>
        </span>
      </div>
      {s ? (
        <>
          <ul className="divide-y divide-line/60">
            <Check ok={!s.mint_authority || issuer} label={s.mint_authority ? "Mint authority aktif" : "Mint authority nonaktif"} />
            <Check ok={!s.freeze_authority || issuer} label={s.freeze_authority ? "Freeze authority aktif" : "Freeze authority nonaktif"} />
            <Check
              ok={!s.transfer_fee_pct}
              label={
                s.transfer_fee_pct
                  ? `Pajak transfer ${s.transfer_fee_pct}% tiap transfer`
                  : s.transfer_fee_mutable
                    ? "Pajak transfer 0%, tapi bisa dinaikkan"
                    : "Tanpa pajak transfer"
              }
            />
            <Check
              ok={s.top10_pct == null || s.top10_pct < 30 || issuer}
              label="Top 10 holder (tanpa pool/locker)"
              detail={fmtPct(s.top10_pct)}
            />
            <Check ok={!s.rugged} label={s.rugged ? "Ditandai rugged" : "Tidak ditandai rugged"} />
            <Check ok label="Total holder" detail={s.total_holders != null ? integer.format(s.total_holders) : "–"} />
          </ul>
          {issuer && (
            <p className="mt-2 text-xs text-ink-3">
              Token besar terverifikasi: authority dikontrol penerbit, bukan tanda rug.
            </p>
          )}
          {s.risks.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[11px] text-ink-3">Temuan RugCheck</div>
              <div className="flex flex-wrap gap-1.5">
                {s.risks.map((r) => (
                  <span key={r} className="rounded-md border border-line bg-raised/60 px-2 py-0.5 text-[11px] text-ink-2">
                    {r}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="mt-3 text-[11px] text-ink-3">Dicek {fmtTime(s.fetched_at, false)} WIB via RugCheck</p>
        </>
      ) : (
        <p className="text-sm text-ink-3">Menunggu data RugCheck…</p>
      )}
    </Section>
  );
}

function DrawerContent({ row, onClose }: { row: PoolRow; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const plan = row.plan;
  const flags = sortFlags(row.flags);

  const copy = async () => {
    await navigator.clipboard.writeText(row.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-white/[0.06] bg-panel/92 px-5 py-4 shadow-[0_10px_32px_rgba(0,0,0,0.22)] backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <TokenAvatar symbol={row.base_symbol} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{row.name}</h2>
            <button onClick={copy} className="mt-0.5 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink-2">
              {shortAddress(row.address)}
              {copied ? <CheckIcon width={12} height={12} /> : <CopyIcon width={12} height={12} />}
            </button>
          </div>
          {/* Icon-only pair: both actions open a view of this pool, so they read as one group. Labelled for
              screen readers and on hover, because an icon button with no text says nothing on its own. */}
          <Link
            href={`/pool/${row.address}`}
            aria-label="Buka grafik pool"
            title="Buka grafik pool"
            className="rounded-xl border border-white/[0.08] p-1.5 text-ink-2 transition-colors hover:border-accent/70 hover:text-ink"
          >
            <CandleIcon />
          </Link>
          <a
            href={`https://meteora.ag/dlmm/${row.address}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Buka pool di Meteora"
            title="Buka pool di Meteora"
            className="rounded-lg border border-brand-meteora/45 p-1.5 text-brand-meteora transition-colors hover:border-brand-meteora hover:bg-brand-meteora/10"
          >
            <ExternalLinkIcon />
          </a>
          <button
            onClick={onClose}
            aria-label="Tutup detail"
            className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-raised hover:text-ink"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <PlanBadge plan={plan} size="md" />
          <div className="text-right">
            <div className="text-2xl font-semibold leading-none">{row.score.toFixed(1)}</div>
            <div className="mt-1 text-[11px] text-ink-3">Skor dari 100</div>
          </div>
        </div>
        {isActivePlan(plan) && (
          <p className="mt-3 rounded-xl border border-white/[0.08] bg-bg/55 px-3 py-2 text-xs leading-5 text-ink-2 shadow-inner shadow-black/10">
            {plan.tier_reason}
            <span className="block text-ink-3">{TIER_META[plan.tier].hint}</span>
          </p>
        )}
        {!isActivePlan(plan) && (
          <p className="mt-3 flex items-center gap-2 rounded-xl border border-white/[0.08] bg-bg/55 px-3 py-2 text-sm text-ink-2 shadow-inner shadow-black/10">
            <AlertIcon className="shrink-0 text-ink-3" /> {plan.reason}
          </p>
        )}
      </div>

      <PumpWarning changePct1h={row.change_pct_1h} />

      <Section title="Pasar">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Harga">
            <span className="font-mono text-[13px]">{fmtPrice(row.price)}</span>
          </Stat>
          <Stat label="1 jam">
            <Delta value={row.change_pct_1h} />
          </Stat>
          <Stat label="Volatilitas 1j">{fmtPct(row.realized_vol_pct_1h)}</Stat>
          <Stat label="TVL">{usdCompact.format(row.tvl)}</Stat>
          <Stat label="Volume 24j">{usdCompact.format(row.volume_24h)}</Stat>
          <Stat label="Vol / TVL">{row.volume_tvl_24h.toFixed(1)}×</Stat>
          <Stat label="Fee posisi/hari">{fmtPct(row.fee_for_position_pct_day, 2)}</Stat>
          <Stat label="Likuiditas/bin dekat harga">
            {row.depth?.per_bin_usd != null ? `${usd.format(row.depth.per_bin_usd)} · ±${row.depth.window_bins} bin` : "–"}
          </Stat>
          <Stat label="Fee/TVL 24j">{fmtPct(row.fee_tvl_pct_24h, 2)}</Stat>
          <Stat label="Fee 1j × 24">{fmtPct(row.fee_tvl_pct_1h_x24, 2)}</Stat>
          <Stat label="Bin step">
            {row.bin_step} <span className="text-xs font-normal text-ink-3">{binStepPct(row.bin_step)}/bin</span>
          </Stat>
          <Stat label="Base fee">{fmtPct(row.base_fee_pct, 2)}</Stat>
          <Stat label="Fee dinamis">
            {fmtPct(row.dynamic_fee_pct, 4)}
            {row.fee_multiple_now != null && (
              <span className="ml-1 text-xs font-normal text-ink-3">{row.fee_multiple_now.toFixed(2)}× base</span>
            )}
          </Stat>
          <Stat label="Umur pool">{fmtAge(row.pool_age_hours)}</Stat>
          <Stat label="Market cap">{usdCompact.format(row.market_cap)}</Stat>
          <Stat label="Holder">{compact.format(row.holders)}</Stat>
        </dl>
      </Section>

      <Section title="Jam ramai (WIB)">
        <BusyHours pool={row.address} />
      </Section>

      <IndicatorSection row={row} />

      {isActivePlan(plan) && (
        <>
          <PlanSection
            plan={plan}
            binStep={row.bin_step}
            price={row.price}
            quote={row.name.split("-").pop() ?? ""}
          />
          <ExitSection plan={plan} />
        </>
      )}
      {!isActivePlan(plan) && plan.risky && (
        <RiskyPlanSection
          risky={plan.risky}
          reason={plan.reason}
          binStep={row.bin_step}
          price={row.price}
          quote={row.name.split("-").pop() ?? ""}
        />
      )}
      {!isActivePlan(plan) && plan.risky === null && (
        <p className="rounded-2xl border border-rose-400/30 bg-rose-400/[0.05] px-4 py-3 text-sm text-ink-2">
          Tidak ada saran range: token ini bisa dicetak, dibekukan, atau sudah terindikasi rug. Range apa pun tetap bisa kehilangan seluruh modal.
        </p>
      )}

      <SecuritySection row={row} />

      <InsiderSection row={row} />
      <OrganicSection row={row} />
      <PumpSection row={row} />

      {flags.length > 0 && (
        <Section title="Sinyal">
          <ul className="space-y-2">
            {flags.map((f) => {
              const meta = flagMeta(f);
              return (
                <li key={f} className="flex items-start gap-2.5 text-sm">
                  <span className="flex h-5 items-center">
                    <StatusDot severity={meta.severity} />
                  </span>
                  <span>
                    <span className="font-medium text-ink">{meta.label}</span>
                    <span className="text-ink-3"> · {meta.title}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {/* The Meteora link moved up beside the chart button; the disclaimer stays, it is not decoration. */}
      <div className="mt-auto border-t border-line bg-bg/25 px-5 py-3">
        <p className="text-center text-[11px] text-ink-3">Heuristik, bukan saran finansial.</p>
      </div>
    </div>
  );
}

export default function PoolDrawer({ row, onClose }: { row: PoolRow | null; onClose: () => void }) {
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, onClose]);

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] transition-opacity duration-200 ${
          row ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={row ? `Detail ${row.name}` : "Detail pool"}
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-[500px] overflow-y-auto border-l border-white/[0.06] bg-panel shadow-2xl shadow-black/70 transition-transform duration-200 ease-out ${
          row ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {row && <DrawerContent key={row.address} row={row} onClose={onClose} />}
      </aside>
    </>
  );
}
