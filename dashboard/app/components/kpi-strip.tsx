import type { ReactNode } from "react";
import { TIER_META } from "../lib/flags";
import { fmtPct, integer, median } from "../lib/format";
import type { PoolRow, Tier } from "../lib/types";
import { StatusDot } from "./ui";

function Tile({ label, value, hint }: { label: ReactNode; value: ReactNode; hint: ReactNode }) {
  return (
    <div className="group relative min-w-0 overflow-hidden rounded-xl border border-line bg-panel/90 px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-line-strong">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
      <div className="flex min-w-0 items-center gap-2 truncate text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</div>
      <div className="mt-1 truncate text-xs text-ink-3">{hint}</div>
    </div>
  );
}

function TierTile({ tier, rows }: { tier: Tier; rows: PoolRow[] }) {
  const meta = TIER_META[tier];
  const inTier = rows.filter((r) => r.plan.tier === tier);
  const fee = median(inTier.map((r) => r.fee_for_position_pct_day));
  return (
    <Tile
      label={
        <>
          <StatusDot severity={meta.severity} /> {meta.label}
        </>
      }
      value={integer.format(inTier.length)}
      hint={`Median fee posisi ${fmtPct(fee, 1)}/hari`}
    />
  );
}

export default function KpiStrip({ rows }: { rows: PoolRow[] }) {
  const excluded = rows.filter((r) => r.plan.action === "avoid").length;
  const onchain = rows.filter((r) => r.watched).length;
  const checked = rows.filter((r) => r.security).length;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      <Tile
        label="Pool dipantau"
        value={integer.format(rows.length)}
        hint={`${onchain} on-chain · RugCheck ${checked}/${rows.length}`}
      />
      <TierTile tier="low" rows={rows} />
      <TierTile tier="medium" rows={rows} />
      <TierTile tier="high" rows={rows} />
      <Tile
        label={
          <>
            <StatusDot severity="critical" /> Tidak direkomendasikan
          </>
        }
        value={integer.format(excluded)}
        hint="Flag keamanan berat, dump/pump"
      />
    </div>
  );
}
