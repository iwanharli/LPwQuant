"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ENGINE_URL, fmtDateTime, usd } from "../../lib/format";

type Position = {
  position: string;
  pool: string;
  status: string;
  opened_at: number | null;
  closed_at: number | null;
  meteora_pnl_usd: number | null;
  fees_usd: number | null;
  deposit_usd: number | null;
  swaps: number;
  swap_volume: number;
  outside_share: number;
  cost_lp: number;
  cost_swaps: number;
  net: number;
};
type Coin = {
  mint: string;
  symbol: string;
  cash: number;
  qty: number;
  held: number;
  held_wallet?: number;
  held_lp?: number;
  held_orders?: number;
  net: number;
  by: { swap_buy: number; swap_sell: number; lp_in: number; lp_out: number; fees: number; orders: number; other: number };
  costs: { network: number; pool_fees: number; total: number; other_dex_swaps: number };
  positions: Position[];
};
type NetPnl = {
  total_pl_usd: number;
  coins_total_usd: number;
  buckets: { capital: number; gacha: number; conversion: number; unassigned: number; sol_price_effect: number };
  costs: { network: number; pool_fees: number; total: number; other_dex_swaps: number; unpriced_fees: number; costs_known_txs: number; transactions: number };
  checks: { unassigned_transactions: number; multi_token_transactions: number; positions_indexed: number; lp_transactions_matched: number };
  coins: Coin[];
  computed_at?: number;
};

const money = (v: number) => `${v >= 0 ? "+" : "−"}${usd.format(Math.abs(v))}`;
const tone = (v: number) => (v > 0.005 ? "text-emerald-300" : v < -0.005 ? "text-rose-300" : "text-ink-2");

function Flow({ label, v, hint }: { label: string; v: number; hint?: string }) {
  if (Math.abs(v) < 0.005) return null;
  return (
    <div className="flex justify-between gap-3 text-xs tabular-nums" title={hint}>
      <span className="text-ink-3">{label}</span>
      <span className={tone(v)}>{money(v)}</span>
    </div>
  );
}

function CoinRow({ c }: { c: Coin }) {
  const [open, setOpen] = useState(false);
  const traded = c.by.swap_buy + c.by.swap_sell;
  const lp = c.by.lp_in + c.by.lp_out + c.by.fees;
  const meteora = c.positions.reduce((n, p) => n + (p.meteora_pnl_usd ?? 0), 0);
  return (
    <li className="border-b border-white/[0.04] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="grid w-full grid-cols-[minmax(0,1fr)_6.5rem_14px] items-center gap-x-4 px-4 py-3 text-left transition-colors hover:bg-white/[0.025] sm:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_6.5rem_5rem_6.5rem_14px]"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-ink">{c.symbol}</span>
          <span className="text-[11px] text-ink-3">
            {c.positions.length ? `${c.positions.length} posisi LP` : "tanpa posisi LP"}
            {c.held > 0.5 ? ` · masih dipegang ${usd.format(c.held)}` : ""}
          </span>
        </span>
        <span className="hidden text-right text-xs tabular-nums sm:block">
          <span className={`block ${tone(traded)}`}>{money(traded)}</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">swap</span>
        </span>
        <span className="hidden text-right text-xs tabular-nums sm:block">
          <span className={`block ${tone(lp)}`}>{money(lp)}</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">LP + fee</span>
        </span>
        <span className="hidden text-right text-xs tabular-nums sm:block">
          <span className={`block ${c.positions.length ? tone(meteora) : "text-ink-3"}`}>{c.positions.length ? money(meteora) : "–"}</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">kata Meteora</span>
        </span>
        <span className="hidden text-right text-xs tabular-nums sm:block" title="Biaya jaringan + fee swap Meteora. Sudah termasuk di angka bersih.">
          <span className="block text-amber-300/90">{usd.format(c.costs.total)}</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">biaya</span>
        </span>
        <span className="text-right tabular-nums">
          <span className={`block text-sm font-semibold ${tone(c.net)}`}>{money(c.net)}</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">bersih</span>
        </span>
        <svg viewBox="0 0 20 20" width={14} height={14} className={`text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden>
          <path d="m7.5 5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="grid gap-4 border-t border-white/[0.04] bg-black/20 px-4 py-4 lg:grid-cols-[18rem_1fr]">
          {/* How the coin's net adds up, every line a sum of real transactions. */}
          <div className="space-y-1.5 rounded-xl border border-white/[0.06] p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Rincian {c.symbol}</div>
            <Flow label="Beli lewat swap" v={c.by.swap_buy} />
            <Flow label="Jual lewat swap" v={c.by.swap_sell} />
            <Flow label="Setor ke LP" v={c.by.lp_in} hint="SOL/USDC yang masuk ke posisi" />
            <Flow label="Tarik dari LP" v={c.by.lp_out} hint="SOL/USDC yang keluar dari posisi" />
            <Flow label="Claim fee" v={c.by.fees} />
            <Flow label="Limit order" v={c.by.orders} />
            <Flow label="Lainnya (biaya, transfer)" v={c.by.other} />
            <Flow label="Masih dipegang (harga sekarang)" v={c.held} />
            <div className="mt-2 space-y-1 rounded-lg bg-amber-400/[0.06] p-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/80">Biaya (sudah termasuk di atas)</div>
              <Flow label="Biaya jaringan + priority" v={-c.costs.network} />
              <Flow label="Fee swap Meteora" v={-c.costs.pool_fees} />
              {c.costs.other_dex_swaps > 0 && (
                <div className="text-[10px] leading-4 text-ink-3">+ {c.costs.other_dex_swaps} swap lewat DEX lain: fee-nya tidak terbaca, tapi tetap termasuk di angka bersih.</div>
              )}
            </div>
            <div className="mt-2 flex justify-between border-t border-white/[0.06] pt-2 text-sm font-semibold tabular-nums">
              <span className="text-ink">Bersih</span>
              <span className={tone(c.net)}>{money(c.net)}</span>
            </div>
            <p className="pt-1 text-[11px] leading-4 text-ink-3">
              Token yang ditarik dari LP lalu dijual muncul di &quot;Jual lewat swap&quot;, jadi tidak dihitung dua kali.
            </p>
          </div>

          {c.positions.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs tabular-nums">
                <thead className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
                  <tr>
                    <th className="py-1.5 text-left font-medium">Posisi</th>
                    <th className="py-1.5 text-right font-medium">LP (Meteora)</th>
                    <th className="py-1.5 text-right font-medium">Di luar LP</th>
                    <th className="py-1.5 text-right font-medium" title="Biaya jaringan + fee swap Meteora dari transaksi posisi ini dan swap di sekitarnya">Biaya</th>
                    <th className="py-1.5 text-right font-medium">Bersih</th>
                  </tr>
                </thead>
                <tbody>
                  {[...c.positions].sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0)).map((p) => (
                    <tr key={p.position} className="border-t border-white/[0.04]">
                      <td className="py-1.5 text-ink-2">
                        {p.opened_at ? fmtDateTime(p.opened_at) : "–"} → {p.closed_at ? fmtDateTime(p.closed_at) : <span className="text-accent">masih terbuka</span>}
                        <span className="block text-[10px] text-ink-3">
                          modal {usd.format(p.deposit_usd ?? 0)} · fee {usd.format(p.fees_usd ?? 0)} · {p.swaps} swap ({usd.format(p.swap_volume)})
                        </span>
                      </td>
                      <td className={`py-1.5 text-right ${tone(p.meteora_pnl_usd ?? 0)}`}>{money(p.meteora_pnl_usd ?? 0)}</td>
                      <td className={`py-1.5 text-right ${tone(p.outside_share)}`}>{money(p.outside_share)}</td>
                      <td className="py-1.5 text-right text-amber-300/90">{usd.format(p.cost_lp + p.cost_swaps)}</td>
                      <td className={`py-1.5 text-right font-semibold ${tone(p.net)}`}>{money(p.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] leading-4 text-ink-3">
                LP (Meteora) = hasil di dalam posisi: fee dikurangi IL, token dinilai saat masuk dan keluar posisi. Di luar LP = hasil koin di
                luar posisi (swap, token yang turun setelah keluar, yang masih dipegang), dibagi ke posisi menurut volume swap di sekitarnya:
                sejak posisi sebelumnya ditutup sampai 30 menit setelah posisi ini ditutup. Jumlah semua posisi = bersih koin.
              </p>
            </div>
          ) : (
            <p className="text-xs leading-5 text-ink-3">
              Koin ini hanya dibeli dan dijual lewat swap, tanpa posisi LP. Hasilnya murni dari trading.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** The "Terbaru" order: the coin with the most recently closed position first; coins with only open positions
 * follow, newest opened first. */
function lastActivity(c: Coin): number {
  const closed = Math.max(0, ...c.positions.map((p) => p.closed_at ?? 0));
  if (closed) return closed;
  return -1 / Math.max(1, ...c.positions.map((p) => p.opened_at ?? 0));
}

const PAGE = 15;

/** Calls onVisible when scrolled into view, to show the next page of rows. */
function LoadMore({ onVisible, left }: { onVisible: () => void; left: number }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && onVisible(), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible]);
  return (
    <li ref={ref} className="px-4 py-3 text-center text-[11px] text-ink-3">
      Memuat {left} koin lagi…
    </li>
  );
}

/** Net result per coin and per position, reconciled with the wallet's total P/L. */
export default function NetPnl({ wallet }: { wallet: string }) {
  const [data, setData] = useState<NetPnl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<"recent" | "worst" | "best" | "name">("recent");
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<"all" | "lp" | "swap">("all");
  const [limit, setLimit] = useState(PAGE);
  const more = useCallback(() => setLimit((n) => n + PAGE), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${ENGINE_URL}/api/portfolio/netpnl?wallet=${wallet}${reloadKey ? "&fresh=true" : ""}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b?.detail ?? `HTTP ${r.status}`);
        return b as NetPnl;
      })
      .then((b) => !cancelled && setData(b))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Gagal memuat"));
    return () => {
      cancelled = true;
    };
  }, [wallet, reloadKey]);

  if (error) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">{error}</p>;
  if (!data)
    return (
      <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">
        Menghitung ulang semua transaksi… (pertama kali bisa sampai 2 menit)
      </p>
    );

  const b = data.buckets;
  const coins = data.coins
    .filter((c) => (filter === "all" ? true : filter === "lp" ? c.positions.length > 0 : c.positions.length === 0))
    .sort((x, y) =>
      sort === "recent"
        ? lastActivity(y) - lastActivity(x)
        : sort === "worst"
          ? x.net - y.net
          : sort === "best"
            ? y.net - x.net
            : x.symbol.localeCompare(y.symbol),
    );
  const lpCoins = data.coins.filter((c) => c.positions.length > 0);
  const swapOnly = data.coins.filter((c) => c.positions.length === 0);
  const sum = (cs: Coin[]) => cs.reduce((n, c) => n + c.net, 0);
  const lines = [
    { label: `Koin dengan posisi LP (${lpCoins.length})`, v: sum(lpCoins) },
    { label: `Koin yang hanya di-swap (${swapOnly.length})`, v: sum(swapOnly) },
    { label: "Gacha", v: b.gacha },
    { label: "Konversi SOL ↔ USDC", v: b.conversion },
    { label: "Debu & biaya tak teratribusi", v: b.unassigned },
    { label: "Perubahan harga SOL yang dipegang", v: b.sol_price_effect },
  ];

  return (
    <div className="space-y-4">
      {/* The reconciliation first: the parts must add up to the total, or something is wrong and shows here. */}
      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Hasil bersih: dari mana saja</h2>
            <p className="mt-0.5 text-xs text-ink-3">Setiap transaksi dihitung sekali. Jumlah semua baris = total untung/rugi di tab Ringkasan.</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className={`text-2xl font-semibold tabular-nums ${tone(data.total_pl_usd)}`}>{money(data.total_pl_usd)}</div>
              <div className="text-[11px] text-ink-3">
                total sejak modal disetor{data.computed_at ? ` · dihitung ${fmtDateTime(data.computed_at)}` : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setData(null);
                setReloadKey((k) => k + 1);
              }}
              className="h-9 rounded-xl border border-white/[0.08] px-3 text-sm text-ink-2 hover:border-line-strong hover:text-ink"
            >
              Tarik transaksi terbaru
            </button>
          </div>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {lines.map((l) => (
            <div key={l.label} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
              <span className="text-ink-2">{l.label}</span>
              <span className={`font-medium tabular-nums ${tone(l.v)}`}>{money(l.v)}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-amber-400/[0.04] px-4 py-3 text-sm">
          <span className="text-ink-2">
            Biaya yang sudah dibayar <span className="text-xs text-ink-3">(sudah termasuk di semua angka di atas)</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
            <span className="text-ink-3">jaringan <span className="text-amber-300/90">{usd.format(data.costs.network)}</span></span>
            <span className="text-ink-3">fee swap Meteora <span className="text-amber-300/90">{usd.format(data.costs.pool_fees)}</span></span>
            <span className="text-sm font-semibold text-amber-300">{usd.format(data.costs.total)}</span>
          </span>
          {(data.costs.other_dex_swaps > 0 || data.costs.unpriced_fees > 0 || data.costs.costs_known_txs < data.costs.transactions) && (
            <span className="basis-full text-[11px] text-ink-3">
              {data.costs.other_dex_swaps > 0 && `${data.costs.other_dex_swaps} transaksi lewat DEX lain (Raydium, PumpSwap, dll.): fee swap-nya tidak terbaca dan tidak ada di total biaya ini. `}
              {data.costs.unpriced_fees > 0 && `${data.costs.unpriced_fees} fee dalam memecoin tidak bisa dinilai (swap di dalam rebalance/zap) dan tidak dihitung. `}
              {data.costs.costs_known_txs < data.costs.transactions &&
                `Biaya baru terbaca untuk ${data.costs.costs_known_txs} dari ${data.costs.transactions} transaksi; sisanya sedang diisi.`}
            </span>
          )}
        </div>
        <p className="border-t border-line px-4 py-2.5 text-[11px] leading-5 text-ink-3">
          SOL dinilai dengan harga saat setiap transaksi (candle 30 menit), USDC $1, yang masih dipegang dengan harga sekarang.{" "}
          {data.checks.lp_transactions_matched} transaksi LP tertaut pasti ke {data.checks.positions_indexed} posisi lewat riwayat event Meteora.
        </p>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Per koin · {coins.length}</h2>
          <div className="flex flex-wrap gap-2">
            {([["all", "Semua"], ["lp", "Dengan LP"], ["swap", "Hanya swap"]] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => {
                setFilter(k);
                setLimit(PAGE);
              }}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === k ? "border-accent/70 bg-accent/10 text-ink" : "border-line text-ink-2 hover:text-ink"}`}>
                {label}
              </button>
            ))}
            <select value={sort} onChange={(e) => {
              setSort(e.target.value as typeof sort);
              setLimit(PAGE);
            }} aria-label="Urutkan"
              className="h-7 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-ink-2 focus:outline-none">
              <option value="recent">Terbaru</option>
              <option value="worst">Rugi terbesar dulu</option>
              <option value="best">Untung terbesar dulu</option>
              <option value="name">Nama</option>
            </select>
          </div>
        </div>
        <ul>
          {coins.slice(0, limit).map((c) => <CoinRow key={c.mint} c={c} />)}
          {coins.length > limit && <LoadMore key={limit} onVisible={more} left={coins.length - limit} />}
        </ul>
        <p className="border-t border-line px-4 py-2.5 text-[11px] text-ink-3">
          &quot;Kata Meteora&quot; = PnL posisi menurut Meteora (fee dikurangi IL, token dinilai saat ditarik). &quot;Bersih&quot; = semua SOL/USDC
          masuk dikurangi yang keluar untuk koin itu, ditambah yang masih dipegang, termasuk swap sebelum dan sesudah posisi.
        </p>
      </section>
    </div>
  );
}
