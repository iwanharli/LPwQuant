"use client";

import { useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, fmtSignedPct, shortAddress, usd } from "../../lib/format";

type ClosedPool = {
  address: string;
  name: string;
  token_x_icon: string | null;
  token_y_icon: string | null;
  bin_step: number;
  deposit_usd: number;
  withdrawn_usd: number;
  fees_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  pnl_sol: number;
  closed_at: number | null;
};
type ClosedPosition = {
  address: string;
  opened_at: number | null;
  closed_at: number | null;
  lower_bin: number;
  upper_bin: number;
  min_price: number;
  max_price: number;
  deposit_usd: number;
  fees_usd: number;
  pnl_usd: number;
  pnl_pct: number;
};
type ClosedOrder = {
  address: string;
  pool: string;
  pair: string;
  is_ask: boolean;
  input_token: string;
  output_token: string;
  lower_price: number;
  upper_price: number;
  deposit_usd: number;
  filled_pct: number;
  filled_input: number;
  received_output: number;
  bonus_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  opened_at: number | null;
  closed_at: number | null;
  signature: string | null;
};

function useJson<T>(url: string | null): { data: T | null; error: boolean } {
  const [state, setState] = useState<{ url: string; data: T | null; error: boolean } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((body) => !cancelled && setState({ url, data: body as T, error: false }))
      .catch(() => !cancelled && setState({ url, data: null, error: true }));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state && state.url === url ? state : { data: null, error: false };
}

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const tone = (v: number) => (v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-ink-2");

function duration(from: number | null, to: number | null): string {
  if (!from || !to) return "–";
  const h = (to - from) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)} mnt`;
  if (h < 48) return `${fmtNum(h, 1)} jam`;
  return `${fmtNum(h / 24, 1)} hari`;
}

function Pair({ x, y }: { x: string | null; y: string | null }) {
  return (
    <span className="flex shrink-0 -space-x-2">
      {[x, y].map((src, i) =>
        src ? (
          // eslint-disable-next-line @next/next/no-img-element -- token icons come from many hosts
          <img key={i} src={src} alt="" width={24} height={24} className="h-6 w-6 rounded-full border-2 border-[#0e1217] bg-raised object-cover" />
        ) : (
          <span key={i} className="h-6 w-6 rounded-full border-2 border-[#0e1217] bg-raised" />
        ),
      )}
    </span>
  );
}

function Stat({ label, value, hint, cls = "text-ink" }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-3.5 backdrop-blur-sm">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight ${cls}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

function PoolPositions({ wallet, pool }: { wallet: string; pool: string }) {
  const { data, error } = useJson<{ positions: ClosedPosition[] }>(`${ENGINE_URL}/api/portfolio/closed?wallet=${wallet}&pool=${pool}`);
  if (error) return <p className="px-4 py-3 text-xs text-ink-3">Gagal memuat posisi.</p>;
  if (!data) return <p className="px-4 py-3 text-xs text-ink-3">Memuat posisi…</p>;
  return (
    <div className="border-t border-white/[0.05] bg-black/20 px-4 py-2">
      <table className="w-full text-xs tabular-nums">
        <thead className="text-[10px] uppercase tracking-wider text-ink-3">
          <tr>
            <th className="py-1.5 text-left font-medium">Dibuka → ditutup</th>
            <th className="py-1.5 text-left font-medium">Lama</th>
            <th className="py-1.5 text-left font-medium">Range harga</th>
            <th className="py-1.5 text-right font-medium">Modal</th>
            <th className="py-1.5 text-right font-medium">Fee</th>
            <th className="py-1.5 text-right font-medium">PnL</th>
          </tr>
        </thead>
        <tbody>
          {data.positions.map((p) => (
            <tr key={p.address} className="border-t border-white/[0.04]">
              <td className="py-1.5 text-ink-2">
                {p.opened_at ? fmtDateTime(p.opened_at) : "–"} → {p.closed_at ? fmtDateTime(p.closed_at) : "–"}
              </td>
              <td className="py-1.5 text-ink-3">{duration(p.opened_at, p.closed_at)}</td>
              <td className="py-1.5 text-ink-3">
                {fmtNum(p.min_price, p.min_price < 1 ? 8 : 4)} – {fmtNum(p.max_price, p.max_price < 1 ? 8 : 4)}
              </td>
              <td className="py-1.5 text-right text-ink-2">{usd.format(p.deposit_usd)}</td>
              <td className="py-1.5 text-right text-emerald-300/90">{usd.format(p.fees_usd)}</td>
              <td className={`py-1.5 text-right font-medium ${tone(p.pnl_usd)}`}>
                {signed(p.pnl_usd)} <span className="font-normal opacity-80">({fmtSignedPct(p.pnl_pct, 1)})</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every pool the wallet has closed positions in, newest first; a pool opens into its positions. */
export function ClosedPositions({ wallet }: { wallet: string }) {
  const { data, error } = useJson<{ pools: ClosedPool[] }>(`${ENGINE_URL}/api/portfolio/closed?wallet=${wallet}`);
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<"recent" | "pnl" | "worst" | "fees">("recent");
  if (error) return <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-sm text-ink-3">Gagal memuat riwayat posisi dari Meteora.</p>;
  if (!data) return <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-sm text-ink-3">Memuat riwayat posisi…</p>;
  const pools = [...data.pools].sort((a, b) =>
    sort === "pnl" ? b.pnl_usd - a.pnl_usd : sort === "worst" ? a.pnl_usd - b.pnl_usd : sort === "fees" ? b.fees_usd - a.fees_usd : (b.closed_at ?? 0) - (a.closed_at ?? 0),
  );
  const pnl = pools.reduce((n, p) => n + p.pnl_usd, 0);
  const fees = pools.reduce((n, p) => n + p.fees_usd, 0);
  const wins = pools.filter((p) => p.pnl_usd > 0).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="PnL posisi ditutup" value={signed(pnl)} cls={tone(pnl)} hint="Termasuk fee, setelah IL" />
        <Stat label="Fee dikumpulkan" value={usd.format(fees)} cls="text-emerald-300" hint="Semua posisi yang sudah ditutup" />
        <Stat label="Pool untung" value={`${wins} / ${pools.length}`} hint={`${fmtNum((wins / Math.max(1, pools.length)) * 100, 0)}% pool berakhir untung`} />
        <Stat label="IL + biaya" value={signed(pnl - fees)} cls={tone(pnl - fees)} hint="PnL dikurangi fee: yang hilang karena harga" />
      </div>

      <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97] backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Posisi yang sudah ditutup · {pools.length} pool</h2>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label="Urutkan"
            className="h-8 rounded-full border border-line bg-bg/50 px-3 text-xs text-ink-2 focus:outline-none"
          >
            <option value="recent">Terbaru ditutup</option>
            <option value="pnl">PnL terbesar</option>
            <option value="worst">PnL terburuk</option>
            <option value="fees">Fee terbanyak</option>
          </select>
        </div>
        <ul className="divide-y divide-white/[0.04]">
          {pools.map((p) => (
            <li key={p.address}>
              <button
                type="button"
                onClick={() => setOpen(open === p.address ? null : p.address)}
                aria-expanded={open === p.address}
                className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-white/[0.025] sm:grid-cols-[auto_1.4fr_1fr_1fr_1fr_auto]"
              >
                <Pair x={p.token_x_icon} y={p.token_y_icon} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                  <span className="text-[11px] text-ink-3">
                    {p.bin_step}bps · ditutup {p.closed_at ? fmtDateTime(p.closed_at) : "–"}
                  </span>
                </span>
                <span className="hidden text-right text-xs tabular-nums sm:block">
                  <span className="block text-ink-2">{usd.format(p.deposit_usd)}</span>
                  <span className="text-[10px] uppercase tracking-wider text-ink-3">modal</span>
                </span>
                <span className="hidden text-right text-xs tabular-nums sm:block">
                  <span className="block text-emerald-300/90">{usd.format(p.fees_usd)}</span>
                  <span className="text-[10px] uppercase tracking-wider text-ink-3">fee</span>
                </span>
                <span className="text-right tabular-nums">
                  <span className={`block text-sm font-semibold ${tone(p.pnl_usd)}`}>{signed(p.pnl_usd)}</span>
                  <span className={`text-[11px] ${tone(p.pnl_usd)} opacity-80`}>{fmtSignedPct(p.pnl_pct, 1)}</span>
                </span>
                <svg viewBox="0 0 20 20" width={14} height={14} className={`text-ink-3 transition-transform ${open === p.address ? "rotate-90" : ""}`} aria-hidden>
                  <path d="m7.5 5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {open === p.address && <PoolPositions wallet={wallet} pool={p.address} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Limit orders that are finished: how much filled, what came back, realized PnL. */
export function ClosedOrders({ wallet }: { wallet: string }) {
  const { data, error } = useJson<{ orders: ClosedOrder[] }>(`${ENGINE_URL}/api/portfolio/orders/closed?wallet=${wallet}`);
  if (error) return <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-sm text-ink-3">Gagal memuat riwayat limit order.</p>;
  if (!data) return <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-sm text-ink-3">Memuat riwayat limit order…</p>;
  const orders = data.orders;
  const pnl = orders.reduce((n, o) => n + o.pnl_usd, 0);
  const bonus = orders.reduce((n, o) => n + o.bonus_usd, 0);
  const full = orders.filter((o) => o.filled_pct >= 99.9).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="PnL terealisasi" value={signed(pnl)} cls={tone(pnl)} hint={`${orders.length} order selesai`} />
        <Stat label="Bonus fee order" value={usd.format(bonus)} cls="text-emerald-300" hint="Fee yang diterima saat order terisi" />
        <Stat label="Terisi penuh" value={`${full} / ${orders.length}`} hint="Sisanya dibatalkan sebelum penuh" />
      </div>
      <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97] backdrop-blur-sm">
        <div className="border-b border-line bg-raised/20 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Limit order selesai</h2>
        </div>
        {orders.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-3">Belum ada limit order yang selesai.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {orders.map((o) => (
              <li key={o.address} className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 sm:grid-cols-[1.5fr_1fr_1.2fr_1fr_auto]">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    <span className={o.is_ask ? "text-rose-300" : "text-emerald-300"}>{o.is_ask ? "Jual" : "Beli"} {o.is_ask ? o.input_token : o.output_token}</span>
                    <span className="text-ink"> · {o.pair}</span>
                  </span>
                  <span className="text-[11px] text-ink-3">
                    {o.opened_at ? fmtDateTime(o.opened_at) : "–"} → {o.closed_at ? fmtDateTime(o.closed_at) : "–"} · {duration(o.opened_at, o.closed_at)}
                  </span>
                </span>
                <span className="hidden text-xs tabular-nums sm:block">
                  <span className="block text-ink-2">
                    {fmtNum(o.lower_price, 6)} – {fmtNum(o.upper_price, 6)}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-ink-3">rentang harga</span>
                </span>
                <span className="hidden sm:block">
                  <span className="flex items-center gap-2 text-xs tabular-nums">
                    <span className="h-1.5 w-20 overflow-hidden rounded-full bg-raised">
                      <span className="block h-full rounded-full bg-cyan-400" style={{ width: `${Math.min(100, o.filled_pct)}%` }} />
                    </span>
                    <span className="text-ink-2">{fmtNum(o.filled_pct, 0)}%</span>
                  </span>
                  <span className="text-[11px] tabular-nums text-ink-3">
                    dapat {fmtNum(o.received_output, 4)} {o.output_token}
                  </span>
                </span>
                <span className="hidden text-right text-xs tabular-nums sm:block">
                  <span className="block text-ink-2">{usd.format(o.deposit_usd)}</span>
                  <span className="text-[10px] uppercase tracking-wider text-ink-3">dipasang</span>
                </span>
                <span className="flex items-center gap-3 text-right tabular-nums">
                  <span>
                    <span className={`block text-sm font-semibold ${tone(o.pnl_usd)}`}>{signed(o.pnl_usd)}</span>
                    <span className={`text-[11px] ${tone(o.pnl_usd)} opacity-80`}>{fmtSignedPct(o.pnl_pct, 1)}</span>
                  </span>
                  {o.signature && (
                    <a href={`https://solscan.io/tx/${o.signature}`} target="_blank" rel="noreferrer" title={shortAddress(o.signature)} className="text-xs text-accent/80 hover:text-accent">
                      ↗
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
