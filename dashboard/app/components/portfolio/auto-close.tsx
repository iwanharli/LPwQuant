"use client";

import { useCallback, useEffect, useState } from "react";
import { CLAIM_URL, fmtNum } from "../../lib/format";

type Row = {
  position: string;
  enabled: boolean;
  target_pct: number;
  status: "armed" | "closing" | "done" | "failed";
  last_net_pct: number | null;
  error: string | null;
};
type State = { bot_wallet: string | null; positions: Row[] };

// One request for every card on the page, refreshed while any toggle is shown.
let shared: { at: number; promise: Promise<State | null> } | null = null;
function loadState(force = false): Promise<State | null> {
  if (!force && shared && Date.now() - shared.at < 4_000) return shared.promise;
  const promise = fetch(`${CLAIM_URL}/auto-close`)
    .then((r) => (r.ok ? (r.json() as Promise<State>) : null))
    .catch(() => null);
  shared = { at: Date.now(), promise };
  return promise;
}

const TARGETS = [3, 4, 5];

/** Per-position switch for the bot wallet's auto close + sell. Hidden for positions of any other wallet. */
export default function AutoCloseToggle({ owner, pool, position }: { owner: string | undefined; pool: string; position: string }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((force = false) => loadState(force).then(setState), []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!state?.bot_wallet || !owner || owner !== state.bot_wallet) return null;
  const row = state.positions.find((p) => p.position === position);
  const on = !!row?.enabled && row.status === "armed";
  const target = row?.target_pct ?? 4;

  const save = async (enabled: boolean, target_pct: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${CLAIM_URL}/auto-close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position, pool, enabled, target_pct }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
      await refresh(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal");
    } finally {
      setBusy(false);
    }
  };

  if (row?.status === "done") return <span className="text-[11px] font-medium text-emerald-300">Auto close selesai</span>;
  if (row?.status === "closing") return <span className="text-[11px] font-medium text-amber-300">Auto close berjalan…</span>;

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[11px]">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy}
        onClick={() => void save(!on, target)}
        title="Tutup dan jual otomatis oleh wallet bot saat hasil bersih (setelah biaya jual) mencapai target"
        className={`relative h-5 w-9 rounded-full border transition-colors disabled:opacity-50 ${on ? "border-emerald-400/60 bg-emerald-400/30" : "border-line bg-raised/60"}`}
      >
        <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${on ? "left-[18px] bg-emerald-300" : "left-0.5 bg-ink-3"}`} />
      </button>
      <span className="text-ink-2">Auto close</span>
      <select
        value={target}
        disabled={busy}
        onChange={(e) => void save(on, Number(e.target.value))}
        aria-label="Target hasil bersih"
        className="rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 text-ink"
      >
        {TARGETS.map((t) => (
          <option key={t} value={t}>
            +{t}%
          </option>
        ))}
      </select>
      {on && row?.last_net_pct != null && (
        <span className="tabular-nums text-ink-3">
          bersih {row.last_net_pct >= 0 ? "+" : ""}
          {fmtNum(row.last_net_pct, 2)}%
        </span>
      )}
      {(error || row?.error || row?.status === "failed") && (
        <span className="basis-full text-rose-300">{error ?? row?.error ?? "gagal"}</span>
      )}
    </span>
  );
}
