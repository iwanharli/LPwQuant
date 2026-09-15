import { REGIME_META, SEVERITY_DOT, STATUS_META, TIER_META, flagMeta, sortFlags, type Severity } from "../lib/flags";
import type { Plan, Regime } from "../lib/types";

export function StatusDot({ severity, pulse = false }: { severity: Severity; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${SEVERITY_DOT[severity]}`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${SEVERITY_DOT[severity]}`} />
    </span>
  );
}

export function PlanBadge({ plan, size = "sm" }: { plan: Plan; size?: "sm" | "md" }) {
  const meta = plan.action === "enter" ? TIER_META[plan.tier] : STATUS_META[plan.action];
  return (
    <span
      title={meta.hint}
      className={`inline-flex items-center gap-1.5 rounded-md border border-line bg-raised/90 font-medium text-ink shadow-sm shadow-black/15 ${
        size === "md" ? "px-2.5 py-1 text-sm" : "px-2 py-0.5 text-xs"
      }`}
    >
      <StatusDot severity={meta.severity} />
      {meta.label}
    </span>
  );
}

export function RegimeBadge({ regime, adx }: { regime: Regime | null | undefined; adx?: number | null }) {
  if (!regime) return <span className="text-xs text-ink-3">–</span>;
  const meta = REGIME_META[regime];
  return (
    <span className="inline-flex flex-col items-start gap-0.5" title={meta.hint}>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-ink">
        <StatusDot severity={meta.severity} />
        {meta.label}
      </span>
      {adx != null && <span className="text-[11px] tabular-nums text-ink-3">ADX {adx.toFixed(0)}</span>}
    </span>
  );
}

export function FlagChip({ flag }: { flag: string }) {
  const meta = flagMeta(flag);
  return (
    <span
      title={meta.title}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-raised/70 px-1.5 py-0.5 text-[11px] text-ink-2 shadow-sm shadow-black/10"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[meta.severity]}`} />
      {meta.label}
    </span>
  );
}

export function FlagChips({ flags, max = 3 }: { flags: string[]; max?: number }) {
  const sorted = sortFlags(flags);
  const shown = sorted.slice(0, max);
  const rest = sorted.length - shown.length;
  if (sorted.length === 0) return <span className="text-xs text-ink-3">–</span>;
  return (
    <div className="flex items-center gap-1">
      {shown.map((f) => (
        <FlagChip key={f} flag={f} />
      ))}
      {rest > 0 && (
        <span className="text-[11px] text-ink-3" title={sorted.slice(max).map((f) => flagMeta(f).label).join(", ")}>
          +{rest}
        </span>
      )}
    </div>
  );
}

function meterSeverity(ratio: number): Severity {
  if (ratio >= 0.7) return "good";
  if (ratio >= 0.5) return "warning";
  return "critical";
}

/** Horizontal meter: fill carries severity, track stays a quiet step of the surface. */
export function Meter({
  value,
  max,
  width = "w-16",
  thresholds,
}: {
  value: number;
  max: number;
  width?: string;
  thresholds?: (ratio: number) => Severity;
}) {
  const ratio = Math.max(0, Math.min(1, value / max));
  const severity = (thresholds ?? meterSeverity)(ratio);
  return (
    <span className={`relative inline-block h-1.5 overflow-hidden rounded-full bg-line ${width}`}>
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${SEVERITY_DOT[severity]}`}
        style={{ width: `${ratio * 100}%` }}
      />
    </span>
  );
}

export function ScoreCell({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="w-8 text-right font-semibold tabular-nums text-ink">{score.toFixed(0)}</span>
      <Meter
        value={score}
        max={100}
        thresholds={(r) => (r >= 0.7 ? "good" : r >= 0.55 ? "warning" : "info")}
      />
    </span>
  );
}

export function TokenAvatar({ symbol }: { symbol: string | null }) {
  const letters = (symbol ?? "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-accent/25 bg-gradient-to-br from-accent/18 to-raised text-[11px] font-semibold text-ink shadow-sm shadow-black/25">
      {letters}
    </span>
  );
}

export function Delta({ value, digits = 1 }: { value: number | null; digits?: number }) {
  if (value == null) return <span className="text-ink-3">–</span>;
  const tone = value > 0 ? "text-up" : value < 0 ? "text-down" : "text-ink-2";
  return (
    <span className={`tabular-nums ${tone}`}>
      {value > 0 ? "▲" : value < 0 ? "▼" : ""} {Math.abs(value).toFixed(digits)}%
    </span>
  );
}
