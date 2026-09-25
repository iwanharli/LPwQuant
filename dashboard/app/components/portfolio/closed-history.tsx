"use client";

import { useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "../../lib/auto-refresh";
import { ENGINE_URL, TIMEZONE, fmtDateTime, fmtNum, fmtSignedPct, shortAddress, usd } from "../../lib/format";
import { useUrlState } from "../../lib/url-state";
import { SkeletonTable, SkeletonTiles } from "../skeleton";

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

function Stat({ label, value, hint, cls = "text-ink" }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3.5 backdrop-blur-sm">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight ${cls}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

/** Every tile is the same height whatever it holds: one line of label, one of value, one of hint. Cards sit side
 * by side in a grid, so a tile that wraps would push its neighbours' rows out of line. */
function Tile({ label, value, hint, cls }: { label: string; value: React.ReactNode; hint?: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#1b222c] px-3 py-2.5 transition-colors hover:border-white/[0.14] hover:bg-[#222a36]">
      <div className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1.5 truncate text-[18px] font-semibold leading-none tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      <div className="mt-1.5 h-4 truncate text-[11px] leading-4 text-ink-3">{hint ?? ""}</div>
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
    <div className="mt-3">
      <div className="relative h-2.5 rounded-full bg-[#232b36] ring-1 ring-inset ring-white/[0.06]">
        {at != null && (
          <>
            <span
              className={`absolute inset-y-0 left-0 rounded-full ${positive ? "bg-gradient-to-r from-emerald-500/40 to-emerald-400" : "bg-gradient-to-r from-rose-500/40 to-rose-400"}`}
              style={{ width: `${at * 100}%` }}
            />
            <span
              className="absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-ink shadow-[0_0_0_3px_#0f141b]"
              style={{ left: `calc(${at * 100}% - 1.5px)` }}
            />
          </>
        )}
      </div>
      <div className="mt-1.5 grid grid-cols-3 items-baseline gap-2 text-[11px] tabular-nums text-ink-3">
        <span className="truncate">{px(min)}</span>
        <span className={`truncate text-center ${at == null ? "text-ink-3" : "font-medium text-ink-2"}`}>
          {last == null ? "harga akhir tidak tersimpan" : px(last)}
        </span>
        <span className="truncate text-right">{px(max)}</span>
      </div>
    </div>
  );
}

const EXIT = {
  below: { label: "Jatuh keluar", cls: "text-rose-300", chip: "border-rose-400/30 bg-rose-400/10 text-rose-300", hint: "berakhir memegang token" },
  above: { label: "Naik keluar", cls: "text-emerald-300", chip: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", hint: "berakhir memegang SOL/USDC" },
  inside: { label: "Di dalam range", cls: "text-ink-2", chip: "border-line bg-raised/60 text-ink-2", hint: "ditutup sebelum harga keluar" },
};

/** One closed position as a card: only what actually moved, and the net that came back. Meteora's own PnL is left
 * out on purpose -- it ignores the swaps in and out, which is where this wallet's money really went.
 *
 * The rows are fixed: name and dates, then the result, then the range, then two tile rows. Cards in a grid only
 * read as one table when every card puts the same thing at the same height. */
function PositionCard({ p, pool, cost, net }: { p: ClosedPosition; pool?: string; cost: number | null; net: number | null }) {
  const basis = p.deposited_usd ?? p.deposit_usd;
  const pct = net != null && basis > 0 ? (net / basis) * 100 : null;
  const exit = p.exit_side ? EXIT[p.exit_side] : null;
  const positive = (net ?? 0) >= 0;
  return (
    <div
      className={`relative flex flex-col overflow-hidden rounded-2xl border p-4 shadow-[0_18px_44px_rgba(0,0,0,0.35)] ${
        net == null
          ? "border-white/[0.08] bg-[#151b24]"
          : positive
            ? "border-emerald-400/25 bg-[#122019]"
            : "border-rose-400/25 bg-[#1f1419]"
      }`}
    >
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${net == null ? "bg-white/10" : positive ? "bg-emerald-400/70" : "bg-rose-400/70"}`} />

      <div className="flex items-center justify-between gap-2 pl-1">
        <span className="truncate text-[15px] font-semibold text-ink">{pool ? pool.replace("-", "/") : ""}</span>
        <span className="shrink-0 whitespace-nowrap rounded-full border border-line bg-[#11161d] px-2 py-0.5 text-[10px] tabular-nums text-ink-3">
          {p.opened_at ? fmtDateTime(p.opened_at) : "–"} → {p.closed_at ? fmtDateTime(p.closed_at) : "–"}
        </span>
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-2 pl-1">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-3">Hasil bersih</div>
          <div className="mt-1 flex items-baseline gap-2">
            {net == null ? (
              <span className="flex items-center gap-2" title="Hasil bersih posisi ini sedang dihitung">
                <span className="h-[26px] w-28 animate-pulse rounded-md bg-white/[0.08]" />
                <span className="text-[11px] text-ink-3">menghitung…</span>
              </span>
            ) : (
              <span className={`text-[26px] font-semibold leading-none tracking-tight tabular-nums ${tone(net)}`}>{signed(net)}</span>
            )}
            {pct != null && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
                  positive ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300"
                }`}
              >
                {fmtSignedPct(pct, 1)}
              </span>
            )}
          </div>
        </div>
        <span className={`shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium ${exit ? exit.chip : "border-line bg-raised/40 text-ink-3"}`}>
          {exit ? exit.label : "akhir tidak diketahui"}
        </span>
      </div>

      <RangeBar min={p.min_price} max={p.max_price} last={p.last_price} positive={positive} />

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <Tile label="Modal masuk" value={usd.format(basis)} hint={p.tx_count ? `${p.tx_count} transaksi` : "–"} />
        <Tile
          label="Ditarik keluar"
          value={p.withdrawn_usd == null ? "–" : usd.format(p.withdrawn_usd)}
          hint={p.claimed_usd > 0 ? `+ ${usd.format(p.claimed_usd)} fee diklaim` : "saat posisi ditutup"}
        />
        <Tile label="Fee terkumpul" value={usd.format(p.fees_usd)} cls="text-emerald-300" hint="menurut Meteora" />
        <Tile
          label="Biaya"
          value={cost == null ? <span className="inline-block h-[18px] w-16 animate-pulse rounded bg-white/[0.08] align-middle" /> : usd.format(cost)}
          cls="text-amber-300"
          hint="jaringan + fee swap Meteora"
        />
        <Tile
          label="Di dalam range"
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
          hint="fee hanya saat di dalam"
        />
        <Tile
          label="Lama dipegang"
          value={duration(p.opened_at, p.closed_at)}
          hint={`lebar range ±${fmtNum(p.min_price > 0 ? ((p.max_price / p.min_price - 1) * 100) / 2 : 0, 0)}%`}
        />
      </div>
    </div>
  );
}

function Chips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.value ? "bg-accent/15 text-accent" : "text-ink-3 hover:text-ink-2"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const now = () => Date.now(); // outside the component: the purity lint cannot tell filters from render output

type Period = "1d" | "7d" | "30d" | "all";
const PERIODS = ["1d", "7d", "30d", "all"] as const;
const PERIOD_DAYS: Record<Period, number | null> = { "1d": 0, "7d": 6, "30d": 29, all: null };
const PERIOD_LABEL: Record<Period, string> = { "1d": "Hari ini", "7d": "7 hari", "30d": "30 hari", all: "Semua" };
const PERIOD_HINT: Record<Period, string> = {
  "1d": "hari ini",
  "7d": "7 hari kalender terakhir",
  "30d": "30 hari kalender terakhir",
  all: "sejak awal",
};

/** Midnight in Jakarta, `daysBack` calendar days ago, as a timestamp. Calendar days, not a rolling window, so the
 * period matches the daily figures on the summary page. */
function midnightWib(daysBack: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now() - daysBack * 86_400_000));
  return new Date(`${parts}T00:00:00+07:00`).getTime();
}

type RecentPosition = ClosedPosition & {
  pool: string;
  name: string;
  /** Written by the cost accounting when it last ran; null until a position has been through it. */
  cost_usd: number | null;
  net_usd: number | null;
  net_at: number | null;
};

/** Closed positions as one stream, newest first. Grouping by pool hid the thing that matters most -- what you did
 * last -- behind a click, and most pools here hold a single position anyway. */
const PAGE_SIZE = 60;
const CARDS_PER_PAGE = 9;

/** The shape of the page while the first rows are still coming, so the layout does not jump when they land. */
function HistorySkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3.5">
            <div className="h-3 w-24 animate-pulse rounded bg-white/[0.07]" />
            <div className="mt-2.5 h-7 w-32 animate-pulse rounded bg-white/[0.09]" />
            <div className="mt-2 h-3 w-40 animate-pulse rounded bg-white/[0.05]" />
          </div>
        ))}
      </div>
      <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3 text-sm text-ink-3">Memuat riwayat posisi…</p>
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-white/[0.06] bg-[#151b24] p-4">
            <div className="h-4 w-28 animate-pulse rounded bg-white/[0.08]" />
            <div className="mt-3 h-7 w-36 animate-pulse rounded bg-white/[0.09]" />
            <div className="mt-4 h-2.5 w-full animate-pulse rounded-full bg-white/[0.06]" />
            <div className="mt-4 grid grid-cols-2 gap-2.5">
              {[0, 1, 2, 3, 4, 5].map((t) => (
                <div key={t} className="h-[74px] animate-pulse rounded-xl bg-white/[0.04]" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type Page = { positions: RecentPosition[]; done: boolean };

/** Closed positions, newest first, fetched a page at a time and kept in one list. Everything comes from this app's
 * own database -- the index it keeps of every position, with the cost accounting's result stored alongside -- so a
 * page is one query instead of one Meteora call per pool.
 *
 * `cursor` is the closing time to continue after; changing it fetches the next page and appends it. State is only
 * ever set from a promise callback, never in the effect body. */
function useClosedPositions(wallet: string) {
  const [pages, setPages] = useState<Page[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    const url = `${ENGINE_URL}/api/portfolio/positions/recent?wallet=${wallet}&limit=${PAGE_SIZE}${cursor ? `&before=${cursor}` : ""}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((body: { positions: RecentPosition[] }) => {
        if (cancelled) return;
        const page: Page = { positions: body.positions, done: body.positions.length < PAGE_SIZE };
        setPages((old) => (cursor ? [...old, page] : [page]));
        setError(false);
        setLoading(false);
        // A just-closed position arrives before its accounting; the server starts that at once, so look again
        // shortly instead of showing "menghitung" until the next full refresh.
        if (!cursor && body.positions.some((p) => p.net_usd == null)) again = setTimeout(() => setRecheck((n) => n + 1), 5000);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      if (again) clearTimeout(again);
    };
  }, [wallet, cursor, recheck]);

  // New closes: re-read the newest page every 15s while the tab is visible and put it in front of what is loaded.
  const refreshHead = useCallback(() => {
    fetch(`${ENGINE_URL}/api/portfolio/positions/recent?wallet=${wallet}&limit=${PAGE_SIZE}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((body: { positions: RecentPosition[] }) => {
        setPages((old) => {
          if (!old.length) return old;
          const fresh = new Set(body.positions.map((p) => p.address));
          const rest = old.map((pg, i) => ({ ...pg, positions: i === 0 ? [] : pg.positions.filter((p) => !fresh.has(p.address)) }));
          const firstOld = old[0].positions.filter((p) => !fresh.has(p.address));
          return [{ positions: [...body.positions, ...firstOld], done: old[0].done }, ...rest.slice(1)];
        });
      })
      .catch(() => {});
  }, [wallet]);
  useAutoRefresh(refreshHead, 15_000);

  const positions = pages.flatMap((p) => p.positions);
  return {
    positions,
    loading,
    error,
    done: pages.length > 0 && pages[pages.length - 1].done,
    loadMore: () => {
      setLoading(true);
      setCursor(positions.at(-1)?.closed_at ?? null);
    },
  };
}

export function ClosedPositions({ wallet }: { wallet: string }) {
  const [period, setPeriod] = useUrlState<Period>("periode", "7d", PERIODS);
  const [result, setResult] = useState<"all" | "win" | "loss">("all");
  const [exit, setExit] = useState<"all" | "below" | "above" | "inside">("all");
  const [sort, setSort] = useState<"recent" | "best" | "worst" | "size">("recent");
  const [query, setQuery] = useState("");
  const { positions, error, loading, done, loadMore } = useClosedPositions(wallet);
  // Page number belongs to one filter combination: changing any filter goes back to page 1.
  const filterKey = `${period}|${result}|${exit}|${sort}|${query}`;
  const [pager, setPager] = useState({ key: "", n: 0 });

  if (error && positions.length === 0)
    return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Gagal memuat riwayat posisi.</p>;
  if (positions.length === 0 && loading) return <HistorySkeleton />;

  const days = PERIOD_DAYS[period];
  const since = days == null ? 0 : midnightWib(days);
  const all = positions.filter((p) => (p.closed_at ?? 0) >= since);
  const shown = all
    .filter((p) => (query.trim() ? p.name.toLowerCase().includes(query.trim().toLowerCase()) : true))
    .filter((p) => (result === "all" ? true : result === "win" ? (p.net_usd ?? 0) > 0 : (p.net_usd ?? 0) < 0))
    .filter((p) => (exit === "all" ? true : p.exit_side === exit))
    .sort((a, b) =>
      sort === "best"
        ? (b.net_usd ?? 0) - (a.net_usd ?? 0)
        : sort === "worst"
          ? (a.net_usd ?? 0) - (b.net_usd ?? 0)
          : sort === "size"
            ? (b.deposited_usd ?? b.deposit_usd) - (a.deposited_usd ?? a.deposit_usd)
            : (b.closed_at ?? 0) - (a.closed_at ?? 0),
    );

  const pages = Math.max(1, Math.ceil(shown.length / CARDS_PER_PAGE));
  const pageNo = Math.min(pager.key === filterKey ? pager.n : 0, pages - 1);
  const pageItems = shown.slice(pageNo * CARDS_PER_PAGE, (pageNo + 1) * CARDS_PER_PAGE);
  const goTo = (n: number) => {
    setPager({ key: filterKey, n });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const nets = all.map((p) => p.net_usd).filter((n): n is number => n != null);
  const pending = all.length - nets.length; // positions the cost accounting has not reached yet
  const netAll = all.length === 0 ? 0 : nets.length ? nets.reduce((a, b) => a + b, 0) : null;
  const wins = nets.filter((n) => n > 0).length;
  const deposits = all.reduce((n, p) => n + (p.deposited_usd ?? p.deposit_usd), 0);
  const fees = all.reduce((n, p) => n + p.fees_usd, 0);
  // Older positions are only loaded on demand, so a long period may still be filling.
  const partial = !done && days == null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Hasil bersih"
          value={netAll == null ? "…" : signed(netAll)}
          cls={netAll == null ? "text-ink-3" : tone(netAll)}
          hint={
            all.length === 0
              ? `Tidak ada posisi ditutup ${PERIOD_HINT[period]}`
              : pending > 0
                ? `${pending} posisi masih dihitung`
                : days == null
                  ? "Semua posisi yang sudah dimuat, setelah swap dan biaya"
                  : `Ditutup ${PERIOD_HINT[period]}, setelah swap dan biaya`
          }
        />
        <Stat label="Modal masuk" value={usd.format(deposits)} hint={`${all.length} posisi · ${PERIOD_HINT[period]}`} />
        <Stat label="Fee terkumpul" value={usd.format(fees)} cls="text-emerald-300" hint="Fee yang dipungut posisi-posisi itu" />
        <Stat
          label="Posisi untung"
          value={all.length === 0 ? "–" : nets.length ? `${wins} / ${nets.length}` : "…"}
          hint={
            all.length === 0
              ? "belum ada yang ditutup"
              : nets.length
                ? `${fmtNum((wins / nets.length) * 100, 0)}% posisi pulang membawa untung`
                : "menghitung…"
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.06] bg-panel px-3 py-2.5">
        <h2 className="text-sm font-semibold text-ink">
          Posisi ditutup · {PERIOD_HINT[period]}
          {shown.length !== all.length ? ` · ${shown.length} dari ${all.length}` : ""}
          {partial && <span className="ml-1 font-normal text-ink-3">(memuat bertahap)</span>}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Chips
            value={period}
            onChange={setPeriod}
            options={PERIODS.map((v) => ({ value: v as Period, label: PERIOD_LABEL[v] }))}
          />
          <Chips
            value={result}
            onChange={setResult}
            options={[
              { value: "all", label: "Semua" },
              { value: "win", label: "Untung" },
              { value: "loss", label: "Rugi" },
            ]}
          />
          <select
            value={exit}
            onChange={(e) => setExit(e.target.value as typeof exit)}
            aria-label="Akhir posisi"
            className="h-8 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-ink-2 focus:outline-none"
          >
            <option value="all">Akhir: semua</option>
            <option value="below">Jatuh keluar range</option>
            <option value="above">Naik keluar range</option>
            <option value="inside">Masih di dalam range</option>
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label="Urutkan"
            className="h-8 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-ink-2 focus:outline-none"
          >
            <option value="recent">Terbaru ditutup</option>
            <option value="best">Hasil terbaik</option>
            <option value="worst">Hasil terburuk</option>
            <option value="size">Modal terbesar</option>
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari token"
            aria-label="Cari posisi"
            className="h-8 w-36 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-ink placeholder:text-ink-3 focus:border-accent/70 focus:outline-none"
          />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {pageItems.map((p) => (
          <PositionCard key={p.address} p={p} pool={p.name} cost={p.cost_usd} net={p.net_usd} />
        ))}
        {shown.length === 0 && (
          <div className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-10 text-center lg:col-span-2 2xl:col-span-3">
            <p className="text-sm text-ink-2">
              {all.length === 0 ? `Belum ada posisi yang ditutup ${PERIOD_HINT[period]}.` : "Tidak ada posisi yang cocok dengan filter."}
            </p>
            {period !== "all" && (
              <button
                type="button"
                onClick={() => setPeriod(period === "1d" ? "7d" : period === "7d" ? "30d" : "all")}
                className="mt-3 rounded-full border border-white/[0.08] px-4 py-1.5 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
              >
                Lihat rentang yang lebih panjang
              </button>
            )}
          </div>
        )}
      </div>

      {pages > 1 && (
        <nav className="flex items-center justify-center gap-1.5 text-xs" aria-label="Halaman">
          <button
            type="button"
            onClick={() => goTo(pageNo - 1)}
            disabled={pageNo === 0}
            className="h-8 rounded-full border border-white/[0.08] px-3 text-ink-2 hover:text-ink disabled:opacity-40"
          >
            ‹ Sebelumnya
          </button>
          {Array.from({ length: pages }, (_, i) => i)
            .filter((i) => i === 0 || i === pages - 1 || Math.abs(i - pageNo) <= 1)
            .map((i, j, arr) => (
              <span key={i} className="flex items-center gap-1.5">
                {j > 0 && i - arr[j - 1] > 1 && <span className="text-ink-3">…</span>}
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  aria-current={i === pageNo ? "page" : undefined}
                  className={`h-8 min-w-8 rounded-full px-2.5 tabular-nums ${
                    i === pageNo ? "btn-accent font-semibold" : "border border-white/[0.08] text-ink-2 hover:text-ink"
                  }`}
                >
                  {i + 1}
                </button>
              </span>
            ))}
          <button
            type="button"
            onClick={() => goTo(pageNo + 1)}
            disabled={pageNo >= pages - 1}
            className="h-8 rounded-full border border-white/[0.08] px-3 text-ink-2 hover:text-ink disabled:opacity-40"
          >
            Berikutnya ›
          </button>
        </nav>
      )}

      {!done && pageNo === pages - 1 && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          className="w-full rounded-2xl border border-white/[0.06] bg-panel py-3 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
        >
          {loading ? "Memuat…" : "Muat posisi yang lebih lama"}
        </button>
      )}
      {done && positions.length > 0 && <p className="text-center text-[11px] text-ink-3">Semua {positions.length} posisi sudah dimuat.</p>}
    </div>
  );
}

/** Limit orders that are finished: how much filled, what came back, realized PnL. */
export function ClosedOrders({ wallet }: { wallet: string }) {
  const { data, error } = useJson<{ orders: ClosedOrder[] }>(`${ENGINE_URL}/api/portfolio/orders/closed?wallet=${wallet}`);
  if (error) return <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Gagal memuat riwayat limit order.</p>;
  if (!data) return <div className="space-y-4"><SkeletonTiles count={3} /><SkeletonTable rows={5} columns={5} /></div>;
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
      <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel backdrop-blur-sm">
        <div className="border-b border-line bg-white/[0.02] px-4 py-3">
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
                  <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">rentang harga</span>
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
                  <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">dipasang</span>
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
