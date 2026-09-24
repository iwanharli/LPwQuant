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
  /** From the app's own 30m candles, null for positions older than the ~1 week they are kept. */
  in_range_pct: number | null;
  exit_side: "below" | "above" | "inside" | null;
  last_price: number | null;
  /** From the position's own Meteora events. */
  deposited_usd: number | null;
  withdrawn_usd: number | null;
  claimed_usd: number;
  tx_count: number;
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

const PAGE = 25;

type PositionCost = { pool: string; cost_lp: number; cost_swaps: number; net: number; swaps: number };
type Costs = { positions: Record<string, PositionCost>; costs_known_txs: number; transactions: number };

function Tile({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.045] px-3.5 py-3 transition-colors hover:border-white/[0.12] hover:bg-white/[0.06]">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1.5 text-[19px] font-semibold leading-none tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-1.5 text-[11px] leading-4 text-ink-3">{hint}</div>}
    </div>
  );
}

/** Where the price ended inside (or outside) the range the position served: the filled part is where the price
 * walked, the marker is where it stopped. */
function RangeBar({ min, max, last, positive }: { min: number; max: number; last: number | null; positive: boolean }) {
  const span = max - min;
  const at = last != null && span > 0 ? Math.min(1, Math.max(0, (last - min) / span)) : null;
  const px = (v: number) => fmtNum(v, v < 1 ? 8 : 4);
  return (
    <div className="mt-4">
      <div className="relative h-2.5 rounded-full bg-white/[0.07] ring-1 ring-inset ring-white/[0.06]">
        {at != null && (
          <>
            <span
              className={`absolute inset-y-0 left-0 rounded-full ${positive ? "bg-gradient-to-r from-emerald-400/25 to-emerald-400/60" : "bg-gradient-to-r from-rose-400/25 to-rose-400/55"}`}
              style={{ width: `${at * 100}%` }}
            />
            <span
              className="absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-ink shadow-[0_0_0_3px_rgba(10,13,18,0.9)]"
              style={{ left: `calc(${at * 100}% - 1.5px)` }}
            />
          </>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px] tabular-nums text-ink-3">
        <span>{px(min)}</span>
        <span className={at == null ? "text-ink-3" : "font-medium text-ink-2"}>
          {last == null ? "harga akhir tidak tersimpan" : `harga akhir ${px(last)}`}
        </span>
        <span>{px(max)}</span>
      </div>
    </div>
  );
}

const EXIT = {
  below: { label: "Jatuh keluar range", cls: "text-rose-300", chip: "border-rose-400/30 bg-rose-400/10 text-rose-300", hint: "berakhir memegang token" },
  above: { label: "Naik keluar range", cls: "text-emerald-300", chip: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", hint: "berakhir memegang SOL/USDC" },
  inside: { label: "Masih di dalam range", cls: "text-ink-2", chip: "border-line bg-raised/60 text-ink-2", hint: "ditutup sebelum harga keluar" },
};

/** One closed position as a card: only what actually moved, and the net that came back. Meteora's own PnL is left
 * out on purpose -- it ignores the swaps in and out, which is where this wallet's money really went. */
function PositionCard({ p, cost }: { p: ClosedPosition; cost: PositionCost | undefined }) {
  const net = cost?.net ?? null;
  const basis = p.deposited_usd ?? p.deposit_usd;
  const pct = net != null && basis > 0 ? (net / basis) * 100 : null;
  const exit = p.exit_side ? EXIT[p.exit_side] : null;
  const positive = (net ?? 0) >= 0;
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border bg-gradient-to-br p-4 shadow-[0_18px_44px_rgba(0,0,0,0.35)] sm:p-5 ${
        net == null
          ? "border-white/[0.08] from-white/[0.05] to-white/[0.015]"
          : positive
            ? "border-emerald-400/25 from-emerald-400/[0.10] via-white/[0.03] to-white/[0.015]"
            : "border-rose-400/25 from-rose-400/[0.09] via-white/[0.03] to-white/[0.015]"
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 ${net == null ? "bg-white/10" : positive ? "bg-emerald-400/70" : "bg-rose-400/70"}`}
      />
      <div className="flex flex-wrap items-start justify-between gap-3 pl-1">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-3">Hasil bersih</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-2.5">
            <span className={`text-[34px] font-semibold leading-none tracking-tight tabular-nums ${net == null ? "text-ink-3" : tone(net)}`}>
              {net == null ? "…" : signed(net)}
            </span>
            {pct != null && (
              <span
                className={`rounded-full px-2 py-0.5 text-sm font-semibold tabular-nums ${
                  positive ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300"
                }`}
              >
                {fmtSignedPct(pct, 1)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {exit && <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${exit.chip}`}>{exit.label}</span>}
          <span className="rounded-full border border-line bg-black/20 px-2.5 py-1 text-[11px] tabular-nums text-ink-3">
            {p.opened_at ? fmtDateTime(p.opened_at) : "–"} → {p.closed_at ? fmtDateTime(p.closed_at) : "–"}
          </span>
        </div>
      </div>

      <RangeBar min={p.min_price} max={p.max_price} last={p.last_price} positive={positive} />

      <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Tile label="Modal masuk" value={usd.format(basis)} hint={p.tx_count ? `${p.tx_count} transaksi` : undefined} />
        <Tile
          label="Ditarik keluar"
          value={p.withdrawn_usd == null ? "–" : usd.format(p.withdrawn_usd)}
          hint={p.claimed_usd > 0 ? `+ ${usd.format(p.claimed_usd)} fee diklaim` : "saat posisi ditutup"}
        />
        <Tile label="Fee terkumpul" value={usd.format(p.fees_usd)} cls="text-emerald-300" hint="menurut Meteora" />
        <Tile
          label="Biaya"
          value={cost ? usd.format(cost.cost_lp + cost.cost_swaps) : "…"}
          cls="text-amber-300"
          hint={cost ? `${cost.swaps} swap di sekitarnya` : undefined}
        />
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2.5 lg:grid-cols-3">
        <Tile
          label="Waktu di dalam range"
          value={p.in_range_pct == null ? "–" : `${fmtNum(p.in_range_pct, 0)}%`}
          cls={
            p.in_range_pct == null
              ? "text-ink-3"
              : p.in_range_pct >= 70
                ? "text-emerald-300"
                : p.in_range_pct >= 30
                  ? "text-amber-300"
                  : "text-rose-300"
          }
          hint="fee hanya mengalir saat di dalam"
        />
        <Tile
          label="Lama dipegang"
          value={duration(p.opened_at, p.closed_at)}
          hint={`lebar range ±${fmtNum(p.min_price > 0 ? ((p.max_price / p.min_price - 1) * 100) / 2 : 0, 0)}%`}
        />
        <Tile label="Akhir posisi" value={exit ? exit.label : "–"} cls={exit ? exit.cls : "text-ink-3"} hint={exit?.hint} />
      </div>
    </div>
  );
}

function PoolPositions({ wallet, pool, costs }: { wallet: string; pool: string; costs: Costs | null }) {
  const { data, error } = useJson<{ positions: ClosedPosition[] }>(`${ENGINE_URL}/api/portfolio/closed?wallet=${wallet}&pool=${pool}`);
  if (error) return <p className="px-4 py-3 text-xs text-ink-3">Gagal memuat posisi.</p>;
  if (!data) return <p className="px-4 py-3 text-xs text-ink-3">Memuat posisi…</p>;
  return (
    <div className="space-y-3 border-t border-white/[0.05] bg-black/25 px-3 py-3 sm:px-4">
      {data.positions.map((p) => (
        <PositionCard key={p.address} p={p} cost={costs?.positions[p.address]} />
      ))}
    </div>
  );
}

/** Every pool the wallet has closed positions in, newest first; a pool opens into its positions. */
export function ClosedPositions({ wallet }: { wallet: string }) {
  const { data, error } = useJson<{ pools: ClosedPool[] }>(`${ENGINE_URL}/api/portfolio/closed?wallet=${wallet}`);
  // Costs and net per position come from the full accounting, which takes a moment the first time.
  const { data: costs } = useJson<Costs>(`${ENGINE_URL}/api/portfolio/position-costs?wallet=${wallet}`);
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<"recent" | "pnl" | "worst" | "fees">("recent");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  if (error) return <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-sm text-ink-3">Gagal memuat riwayat posisi dari Meteora.</p>;
  if (!data) return <p className="rounded-2xl border border-line bg-[#0e1217]/[0.97] px-4 py-8 text-sm text-ink-3">Memuat riwayat posisi…</p>;
  const pools = [...data.pools].sort((a, b) =>
    sort === "pnl" ? b.pnl_usd - a.pnl_usd : sort === "worst" ? a.pnl_usd - b.pnl_usd : sort === "fees" ? b.fees_usd - a.fees_usd : (b.closed_at ?? 0) - (a.closed_at ?? 0),
  );
  const fees = pools.reduce((n, p) => n + p.fees_usd, 0);
  const deposits = pools.reduce((n, p) => n + p.deposit_usd, 0);
  const shown = query.trim()
    ? pools.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()) || p.address.toLowerCase().includes(query.trim().toLowerCase()))
    : pools;
  const byPool = (address: string) => Object.values(costs?.positions ?? {}).filter((c) => c.pool === address);
  const netAll = costs ? Object.values(costs.positions).reduce((n, c) => n + c.net, 0) : null;
  const poolNets = costs ? pools.map((p) => byPool(p.address)).filter((rows) => rows.length > 0).map((rows) => rows.reduce((n, c) => n + c.net, 0)) : null;
  const netWins = poolNets ? poolNets.filter((n) => n > 0).length : null;
  const withNet = poolNets ? poolNets.length : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Hasil bersih"
          value={netAll == null ? "…" : signed(netAll)}
          cls={netAll == null ? "text-ink-3" : tone(netAll)}
          hint="Semua posisi ditutup, setelah swap masuk-keluar dan biaya"
        />
        <Stat label="Modal masuk" value={usd.format(deposits)} hint={`${pools.length} pool`} />
        <Stat label="Fee terkumpul" value={usd.format(fees)} cls="text-emerald-300" hint="Fee yang dipungut posisi-posisi itu" />
        <Stat
          label="Pool untung"
          value={netWins == null ? "…" : `${netWins} / ${withNet}`}
          hint={netWins == null ? "menghitung…" : `${fmtNum((netWins / Math.max(1, withNet)) * 100, 0)}% pool pulang membawa untung`}
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-line bg-[#0e1217]/[0.97] backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised/20 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">
            Posisi yang sudah ditutup · {shown.length === pools.length ? `${pools.length} pool` : `${shown.length} dari ${pools.length} pool`}
          </h2>
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE);
              }}
              placeholder="Cari token atau pool"
              aria-label="Cari pool"
              className="h-8 w-44 rounded-full border border-line bg-bg/50 px-3 text-xs text-ink placeholder:text-ink-3 focus:border-accent/70 focus:outline-none"
            />
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
        </div>
        <ul className="divide-y divide-white/[0.04]">
          {shown.slice(0, limit).map((p) => (
            <li key={p.address}>
              <button
                type="button"
                onClick={() => setOpen(open === p.address ? null : p.address)}
                aria-expanded={open === p.address}
                className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3 text-left transition-colors hover:bg-white/[0.025] sm:grid-cols-[auto_minmax(0,1.4fr)_6.5rem_6.5rem_6rem_7rem_14px]"
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
                <span className="hidden text-right text-xs tabular-nums sm:block" title="Biaya jaringan + fee swap Meteora untuk semua posisi di pool ini">
                  <span className="block text-amber-300/90">
                    {costs ? usd.format(byPool(p.address).reduce((n, c) => n + c.cost_lp + c.cost_swaps, 0)) : "…"}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-ink-3">biaya</span>
                </span>
                <span className="text-right tabular-nums">
                  {(() => {
                    const rows = byPool(p.address);
                    const net = rows.length ? rows.reduce((n, c) => n + c.net, 0) : null;
                    return (
                      <>
                        <span className={`block text-sm font-semibold ${net == null ? "text-ink-3" : tone(net)}`}>
                          {costs ? (net == null ? "–" : signed(net)) : "…"}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider text-ink-3">bersih</span>
                      </>
                    );
                  })()}
                </span>
                <svg viewBox="0 0 20 20" width={14} height={14} className={`text-ink-3 transition-transform ${open === p.address ? "rotate-90" : ""}`} aria-hidden>
                  <path d="m7.5 5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {open === p.address && <PoolPositions wallet={wallet} pool={p.address} costs={costs} />}
            </li>
          ))}
          {shown.length > limit && (
            <li className="px-4 py-3 text-center">
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE)}
                className="rounded-full border border-line px-4 py-1.5 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
              >
                Tampilkan {Math.min(PAGE, shown.length - limit)} pool lagi ({shown.length - limit} tersisa)
              </button>
            </li>
          )}
          {shown.length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-3">Tidak ada pool yang cocok.</li>}
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
