"use client";

import { useEffect, useState } from "react";
import {
  CONCENTRATION_MAX_PCT,
  LP_LOCKED_MIN_PCT,
  NEW_LISTING_HOURS,
  type Filters,
  type Preset,
  type Range,
  MAX_PRESETS,
  activeFilterCount,
  defaultFilters,
  deletePreset,
  emptyFilters,
  loadPresets,
  savePreset,
} from "../lib/filters";

type Props = {
  open: boolean;
  onClose: () => void;
  filters: Filters;
  onChange: (f: Filters) => void;
  shown: number;
  total: number;
};

const NUM_FIELDS: { key: keyof Filters; label: string; hint?: string; suffix?: string }[] = [
  { key: "atr", label: "ATR 30m", hint: "volatilitas, penentu IL", suffix: "%" },
  { key: "marketCap", label: "Market cap", suffix: "$" },
  { key: "holders", label: "Holders" },
  { key: "top10", label: "Top 10 holders", suffix: "%" },
  { key: "organic", label: "Jupiter organic score", hint: "0-100" },
  { key: "poolAge", label: "Umur pool", suffix: "jam" },
  { key: "volume", label: "Volume 24j", suffix: "$" },
  { key: "fees", label: "Fee 24j", suffix: "$" },
  { key: "feeTvl", label: "Fee/TVL 24j", suffix: "%" },
  { key: "tvl", label: "TVL", suffix: "$" },
  { key: "baseFee", label: "Base fee", suffix: "%" },
];

const TOGGLES: { key: keyof Filters; label: string; hint: string }[] = [
  { key: "verified", label: "Terverifikasi", hint: "Jupiter menandai token ini verified" },
  { key: "newListing", label: "Pool baru", hint: `umur <= ${NEW_LISTING_HOURS} jam` },
  { key: "lowConcentration", label: "Kepemilikan tidak terpusat", hint: `top 10 <= ${CONCENTRATION_MAX_PCT}%` },
  { key: "noInsiders", label: "Tanpa insider terdeteksi", hint: "RugCheck: insiders_detected = 0" },
  { key: "lpLocked", label: "LP terkunci", hint: `>= ${LP_LOCKED_MIN_PCT}%` },
];

export default function FilterPanel({ open, onClose, filters, onChange, shown, total }: Props) {
  // Read once on mount: loadPresets() returns [] on the server, so this is safe during the server render and
  // fills in on the client. An effect here would setState on every open and cascade a render.
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const active = activeFilterCount(filters);
  const setRange = (key: keyof Filters, side: keyof Range, raw: string) => {
    const value = raw.trim() === "" ? null : Number(raw.replace(/,/g, ""));
    if (value !== null && Number.isNaN(value)) return;
    onChange({ ...filters, [key]: { ...(filters[key] as Range), [side]: value } });
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Tutup filter" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-panel shadow-2xl">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Filter</h2>
            <p className="text-[11px] text-ink-3">
              {shown} dari {total} pool{active > 0 ? ` · ${active} filter aktif` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onChange(defaultFilters())}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-accent/70 hover:text-ink"
            >
              Default LP
            </button>
            {active > 0 && (
              <button
                type="button"
                onClick={() => onChange(emptyFilters())}
                className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-accent/70 hover:text-ink"
              >
                Hapus semua
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup"
              className="rounded-md px-2 py-1 text-ink-3 transition-colors hover:bg-raised hover:text-ink"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              Preset {presets.length > 0 && <span className="text-ink-3">({presets.length}/{MAX_PRESETS})</span>}
            </h3>
            {presets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {presets.map((preset) => (
                  <span
                    key={preset.name}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-bg/40 pl-3 pr-1 text-xs text-ink-2"
                  >
                    <button
                      type="button"
                      onClick={() => onChange({ ...emptyFilters(), ...preset.filters })}
                      className="py-1.5 transition-colors hover:text-ink"
                    >
                      {preset.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`Hapus preset ${preset.name}`}
                      onClick={() => setPresets(deletePreset(preset.name))}
                      className="rounded-full px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-raised hover:text-ink"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && presetName.trim()) {
                    setPresets(savePreset(presetName, filters));
                    setPresetName("");
                  }
                }}
                placeholder="Nama preset"
                className="h-10 w-full rounded-lg border border-line bg-bg/70 px-3 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-accent/70"
              />
              <button
                type="button"
                disabled={!presetName.trim() || active === 0}
                onClick={() => {
                  setPresets(savePreset(presetName, filters));
                  setPresetName("");
                }}
                className="h-10 shrink-0 rounded-lg border border-line px-3 text-xs font-medium text-ink-2 transition-colors enabled:hover:border-accent/70 enabled:hover:text-ink disabled:opacity-40"
              >
                Simpan
              </button>
            </div>
            {active === 0 && <p className="text-[11px] text-ink-3">Isi filter dulu sebelum menyimpan preset.</p>}
          </section>

          <section className="space-y-3 border-t border-line pt-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Token & pool</h3>
            {NUM_FIELDS.map((f) => {
              const r = filters[f.key] as Range;
              return (
                <label key={String(f.key)} className="block">
                  <span className="mb-1 flex items-baseline justify-between text-sm text-ink-2">
                    {f.label}
                    {(f.suffix || f.hint) && <span className="text-[11px] text-ink-3">{f.suffix ?? f.hint}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <input
                      inputMode="decimal"
                      value={r.min ?? ""}
                      onChange={(e) => setRange(f.key, "min", e.target.value)}
                      placeholder="Min"
                      className="h-10 w-full rounded-lg border border-line bg-bg/70 px-3 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-accent/70"
                    />
                    <span className="text-ink-3">–</span>
                    <input
                      inputMode="decimal"
                      value={r.max ?? ""}
                      onChange={(e) => setRange(f.key, "max", e.target.value)}
                      placeholder="Maks"
                      className="h-10 w-full rounded-lg border border-line bg-bg/70 px-3 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-accent/70"
                    />
                  </span>
                </label>
              );
            })}
          </section>

          <section className="space-y-2 border-t border-line pt-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Keamanan</h3>
            {TOGGLES.map((t) => (
              <label key={String(t.key)} className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5 hover:bg-raised/60">
                <input
                  type="checkbox"
                  checked={filters[t.key] as boolean}
                  onChange={(e) => onChange({ ...filters, [t.key]: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-accent"
                />
                <span>
                  <span className="block text-sm text-ink">{t.label}</span>
                  <span className="block text-[11px] text-ink-3">{t.hint}</span>
                </span>
              </label>
            ))}
          </section>

          <p className="border-t border-line pt-3 text-[11px] leading-5 text-ink-3">
            Default LP diisi ATR &le; 5%, top 10 holders &le; 30%, dan TVL &ge; $25.000 — tiga ambang yang
            punya dasar pengukuran di proyek ini. Sisanya sengaja dikosongkan. Pool yang tidak melaporkan sebuah
            nilai akan keluar dari hasil saat filter itu diisi, bukan lolos diam-diam. Data konsentrasi holder dan LP berasal dari RugCheck, skor organik dari Jupiter, dan
            keduanya tidak tersedia untuk semua token.
          </p>
        </div>
      </aside>
    </div>
  );
}
