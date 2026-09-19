"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CLAIM_URL, fmtNum, shortAddress, usd } from "../../lib/format";

export type Delta = { mint: string; symbol: string; amount: number };
export type Activity = {
  signature: string;
  ts: number;
  kind: string;
  source: "app" | "chain";
  ok: boolean;
  pool: string | null;
  sol_delta: number | null;
  deltas: Delta[];
  note: string | null;
};
export type TokenInfo = { price: number | null; symbol: string | null; icon: string | null };

const SOL_MINT = "So11111111111111111111111111111111111111112";
const GROUP_GAP_MS = 2 * 60_000; // same action within two minutes reads as one ("claim all" sends seven)
const NOISE_USD = 1; // transfers and unknown programs below this are airdrop spam and dust
const QUOTES = new Set(["SOL", "USDC", "USDT", "jlUSDC"]);

// ---- Prices ----------------------------------------------------------------------------------------------------

export function useTokenInfo(mints: string[]) {
  const [info, setInfo] = useState<Record<string, TokenInfo>>({});
  const key = [...new Set(mints)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    const wanted = key.split(",").filter((m) => !(m in info));
    if (wanted.length === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < wanted.length; i += 150) {
        try {
          const res = await fetch(`${CLAIM_URL}/prices?mints=${wanted.slice(i, i + 150).join(",")}`);
          if (!res.ok) continue;
          const body = (await res.json()) as { tokens: Record<string, TokenInfo> };
          if (!cancelled) setInfo((prev) => ({ ...prev, ...body.tokens }));
        } catch {
          // rows show without dollar figures; the next render tries again
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `info` is read only to skip known mints; re-running on every fill would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return info;
}

// ---- Grouping and wording --------------------------------------------------------------------------------------

type Entry = {
  id: string;
  ts: number;
  kind: string;
  items: Activity[];
  deltas: Delta[]; // summed over the group, SOL included
  ok: boolean;
  fromApp: boolean;
};

/** Token changes of one row with native SOL folded in. The network fee alone (a few thousand lamports) is dropped:
 * it is not something the reader did. */
function allDeltas(a: Activity): Delta[] {
  const out = a.deltas.map((d) => ({ ...d })); // copies: the SOL fold below must not change the fetched rows
  if (a.sol_delta != null && Math.abs(a.sol_delta) >= 0.0001) {
    const wsol = out.find((d) => d.mint === SOL_MINT);
    if (wsol) wsol.amount += a.sol_delta;
    else out.push({ mint: SOL_MINT, symbol: "SOL", amount: a.sol_delta });
  }
  return out.filter((d) => Math.abs(d.amount) > 1e-9);
}

function merge(items: Activity[]): Delta[] {
  const by = new Map<string, Delta>();
  for (const a of items)
    for (const d of allDeltas(a)) {
      const prev = by.get(d.mint);
      by.set(d.mint, prev ? { ...prev, amount: prev.amount + d.amount } : { ...d });
    }
  return [...by.values()].filter((d) => Math.abs(d.amount) > 1e-9);
}

function group(items: Activity[]): Entry[] {
  const out: Entry[] = [];
  for (const a of items) {
    const last = out[out.length - 1];
    const groupable = a.kind !== "transfer" && a.kind !== "other" && a.kind !== "deposit" && a.kind !== "withdraw";
    if (last && groupable && last.kind === a.kind && last.items[last.items.length - 1].ts - a.ts <= GROUP_GAP_MS) {
      last.items.push(a);
      continue;
    }
    out.push({ id: a.signature, ts: a.ts, kind: a.kind, items: [a], deltas: [], ok: true, fromApp: false });
  }
  for (const e of out) {
    e.deltas = merge(e.items);
    // A program we do not name that took one token and gave another is a swap (other DEXes, aggregators).
    const moved = e.deltas.filter((d) => d.mint !== SOL_MINT || Math.abs(d.amount) >= 0.01);
    if (e.kind === "other" && moved.some((d) => d.amount > 0) && moved.some((d) => d.amount < 0)) e.kind = "swap";
    e.ok = e.items.every((a) => a.ok);
    e.fromApp = e.items.some((a) => a.source === "app");
  }
  return out;
}

const usdOf = (d: Delta, info: Record<string, TokenInfo>) => {
  const p = info[d.mint]?.price;
  return p == null ? null : d.amount * p;
};

/** Pair a row is about, from the tokens that moved: quote last, the way pools are named (GP/SOL). */
function pairOf(deltas: Delta[]): string | null {
  const syms = [...new Set(deltas.filter((d) => d.mint !== SOL_MINT || Math.abs(d.amount) >= 0.01).map((d) => d.symbol))];
  if (syms.length === 0) return null;
  const base = syms.filter((s) => !QUOTES.has(s));
  const quote = syms.filter((s) => QUOTES.has(s));
  const pair = [...base.slice(0, 1), ...quote.slice(0, 1)];
  return pair.length === 2 ? pair.join("/") : syms.slice(0, 2).join("/");
}

const amt = (v: number) => fmtNum(Math.abs(v), Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4);

function describe(e: Entry, info: Record<string, TokenInfo>): { title: string; value: number | null; tone: "gain" | "neutral" | "cost" } {
  const ins = e.deltas.filter((d) => d.amount > 0);
  const outs = e.deltas.filter((d) => d.amount < 0);
  const sum = (ds: Delta[]) => {
    const vs = ds.map((d) => usdOf(d, info));
    return vs.every((v) => v == null) ? null : vs.reduce<number>((n, v) => n + Math.abs(v ?? 0), 0);
  };
  const n = e.items.length;
  const pair = pairOf(e.deltas);
  switch (e.kind) {
    case "claim":
      return { title: n > 1 ? `Claim fee dari ${n} posisi` : `Claim fee${pair ? ` ${pair}` : ""}`, value: sum(ins), tone: "gain" };
    case "remove_liquidity":
      return { title: n > 1 ? `Tarik likuiditas dari ${n} posisi` : `Tarik likuiditas${pair ? ` ${pair}` : ""}`, value: sum(ins), tone: "neutral" };
    case "add_liquidity":
      return { title: n > 1 ? `Buka ${n} posisi` : `Buka posisi${pair ? ` ${pair}` : ""}`, value: sum(outs), tone: "neutral" };
    case "limit_order_place": {
      // Paying in a quote coin (USDC, SOL) is a buy order; paying in anything else is selling that coin.
      const paid = outs.filter((d) => d.mint !== SOL_MINT || Math.abs(d.amount) >= 0.01).sort((a, b) => a.amount - b.amount)[0];
      const title = !paid
        ? "Pasang limit order"
        : QUOTES.has(paid.symbol)
          ? `Pasang limit order beli · bayar ${amt(paid.amount)} ${paid.symbol}`
          : `Pasang limit order jual ${amt(paid.amount)} ${paid.symbol}`;
      return { title, value: sum(outs), tone: "neutral" };
    }
    case "limit_order_cancel":
      return { title: n > 1 ? `Tarik ${n} limit order` : "Tarik / batal limit order", value: sum(ins), tone: "neutral" };
    case "swap": {
      const from = outs.sort((a, b) => a.amount - b.amount)[0];
      const to = ins.sort((a, b) => b.amount - a.amount)[0];
      const title =
        from && to ? `Swap ${amt(from.amount)} ${from.symbol} → ${amt(to.amount)} ${to.symbol}` : n > 1 ? `${n} swap` : "Swap";
      return { title, value: sum(outs.length ? outs : ins), tone: "neutral" };
    }
    case "rebalance":
      return { title: n > 1 ? `Rebalance ${n} posisi` : `Rebalance posisi${pair ? ` ${pair}` : ""}`, value: sum(outs.length ? outs : ins), tone: "neutral" };
    case "deposit":
      return { title: `Setoran ${ins.map((d) => d.symbol).slice(0, 2).join(" & ")}`, value: sum(ins), tone: "gain" };
    case "withdraw":
      return { title: `Tarik ke luar ${outs.map((d) => d.symbol).slice(0, 2).join(" & ")}`, value: sum(outs), tone: "cost" };
    case "gacha": {
      const paid = sum(outs) ?? 0;
      const back = sum(ins) ?? 0;
      if (outs.length && !ins.length) return { title: n > 1 ? `Beli ${n} pack gacha` : "Beli pack gacha", value: paid, tone: "cost" };
      if (ins.length && !outs.length) return { title: n > 1 ? `${n} kartu dijual kembali` : "Kartu dijual kembali", value: back, tone: "gain" };
      const net = back - paid;
      return { title: `Gacha ${n}× · bersih`, value: Math.abs(net), tone: net >= 0 ? "gain" : "cost" };
    }
    case "transfer":
      return ins.length && !outs.length
        ? { title: `Terima ${ins.map((d) => d.symbol).slice(0, 2).join(" & ")}`, value: sum(ins), tone: "gain" }
        : { title: `Kirim ${outs.map((d) => d.symbol).slice(0, 2).join(" & ") || "token"}`, value: sum(outs), tone: "cost" };
    default:
      return { title: "Transaksi lain", value: sum(e.deltas), tone: "neutral" };
  }
}

// ---- Presentation ----------------------------------------------------------------------------------------------

const KIND_STYLE: Record<string, { tile: string; glyph: ReactNode; label: string }> = {
  claim: { tile: "from-emerald-400/25 to-emerald-500/5 text-emerald-300 ring-emerald-400/25", label: "Claim fee", glyph: <path d="M12 3v12m0 0-4-4m4 4 4-4M5 19h14" /> },
  remove_liquidity: { tile: "from-amber-400/25 to-amber-500/5 text-amber-300 ring-amber-400/25", label: "Tarik likuiditas", glyph: <path d="M4 12h12m0 0-4-4m4 4-4 4M20 5v14" /> },
  add_liquidity: { tile: "from-lime-300/25 to-lime-400/5 text-lime-200 ring-lime-300/25", label: "Buka posisi", glyph: <path d="M12 5v14M5 12h14" /> },
  limit_order_place: { tile: "from-violet-400/25 to-violet-500/5 text-violet-300 ring-violet-400/25", label: "Limit order", glyph: <path d="M5 17 10 12l3 3 6-7M15 8h4v4" /> },
  limit_order_cancel: { tile: "from-violet-400/20 to-violet-500/5 text-violet-300 ring-violet-400/20", label: "Tarik order", glyph: <path d="M6 6l12 12M18 6 6 18" /> },
  rebalance: { tile: "from-teal-400/20 to-teal-500/5 text-teal-300 ring-teal-400/20", label: "Rebalance", glyph: <path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" /> },
  deposit: { tile: "from-sky-400/25 to-sky-500/5 text-sky-300 ring-sky-400/25", label: "Setoran", glyph: <path d="M12 4v12m0 0-4-4m4 4 4-4M4 20h16" /> },
  withdraw: { tile: "from-orange-400/25 to-orange-500/5 text-orange-300 ring-orange-400/25", label: "Penarikan", glyph: <path d="M12 20V8m0 0-4 4m4-4 4 4M4 4h16" /> },
  gacha: { tile: "from-fuchsia-400/25 to-fuchsia-500/5 text-fuchsia-300 ring-fuchsia-400/25", label: "Gacha", glyph: <path d="M5 8h14v11H5zM3 5h18v3H3zM12 5v14M12 5c-2-3-5-2-5 0h5zm0 0c2-3 5-2 5 0h-5z" /> },
  swap: { tile: "from-cyan-400/25 to-cyan-500/5 text-cyan-300 ring-cyan-400/25", label: "Swap", glyph: <path d="M7 7h11l-3-3M17 17H6l3 3" /> },
  transfer: { tile: "from-slate-400/20 to-slate-500/5 text-slate-300 ring-slate-400/20", label: "Transfer", glyph: <path d="M5 12h14m0 0-5-5m5 5-5 5" /> },
  other: { tile: "from-slate-400/15 to-slate-500/5 text-slate-400 ring-slate-400/15", label: "Lainnya", glyph: <path d="M6 12h.01M12 12h.01M18 12h.01" /> },
};

function KindTile({ kind }: { kind: string }) {
  const s = KIND_STYLE[kind] ?? KIND_STYLE.other;
  return (
    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br ring-1 ring-inset ${s.tile}`}>
      <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {s.glyph}
      </svg>
    </span>
  );
}

function TokenChip({ d, info }: { d: Delta; info: Record<string, TokenInfo> }) {
  const icon = info[d.mint]?.icon;
  const pos = d.amount >= 0;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] py-0.5 pl-0.5 pr-2 text-xs tabular-nums">
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element -- token icons come from many hosts
        <img src={icon} alt="" width={16} height={16} className="h-4 w-4 rounded-full bg-raised object-cover" />
      ) : (
        <span className="grid h-4 w-4 place-items-center rounded-full bg-raised text-[8px] font-semibold text-ink-3">{d.symbol.slice(0, 1)}</span>
      )}
      <span className={pos ? "text-emerald-300" : "text-rose-300"}>
        {pos ? "+" : "−"}
        {amt(d.amount)}
      </span>
      <span className="text-ink-3">{d.symbol}</span>
    </span>
  );
}

const timeWib = (ms: number) =>
  new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }).format(ms);
const dayKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(ms);
const dayLabel = (ms: number) => {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86_400_000);
  const k = dayKey(ms);
  const base = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", weekday: "long", day: "numeric", month: "long" }).format(ms);
  return k === today ? `Hari ini · ${base}` : k === yesterday ? `Kemarin · ${base}` : base;
};

function Row({ e, info }: { e: Entry; info: Record<string, TokenInfo> }) {
  const [open, setOpen] = useState(false);
  const d = describe(e, info);
  const chips = [...e.deltas].sort((a, b) => Math.abs(usdOf(b, info) ?? 0) - Math.abs(usdOf(a, info) ?? 0));
  const shown = chips.slice(0, 4);
  const many = e.items.length > 1;
  const note = e.items.find((a) => a.note)?.note;
  return (
    <li className="group/row">
      <div
        className={`grid grid-cols-[3.25rem_2.5rem_1fr_auto] items-center gap-x-4 rounded-2xl px-3 py-3 transition-colors hover:bg-white/[0.025] ${
          e.ok ? "" : "opacity-60"
        }`}
      >
        <span className="text-xs tabular-nums text-ink-3">{timeWib(e.ts)}</span>
        <KindTile kind={e.kind} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[15px] font-medium tracking-tight text-ink ${e.ok ? "" : "line-through"}`}>{d.title}</span>
            {!e.ok && <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-300">Gagal</span>}
            {e.fromApp && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">via Quant</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {shown.map((c) => (
              <TokenChip key={c.mint} d={c} info={info} />
            ))}
            {chips.length > shown.length && <span className="text-xs text-ink-3">+{chips.length - shown.length} token</span>}
            {chips.length === 0 && <span className="text-xs text-ink-3">{note ?? "Tanpa perubahan saldo"}</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div
              className={`text-[15px] font-semibold tabular-nums tracking-tight ${
                d.tone === "gain" ? "text-emerald-300" : d.tone === "cost" ? "text-rose-300" : "text-ink"
              }`}
            >
              {d.value == null ? "–" : `${d.tone === "gain" ? "+" : d.tone === "cost" ? "−" : ""}${usd.format(d.value)}`}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3">{KIND_STYLE[e.kind]?.label ?? "Lainnya"}</div>
          </div>
          {many ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={open ? "Sembunyikan transaksi" : "Lihat transaksi"}
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-white/5 hover:text-ink"
            >
              <svg viewBox="0 0 20 20" width={14} height={14} className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden>
                <path d="m7.5 5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <a
              href={`https://solscan.io/tx/${e.items[0].signature}`}
              target="_blank"
              rel="noreferrer"
              title="Buka di Solscan"
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 opacity-0 transition hover:bg-white/5 hover:text-ink group-hover/row:opacity-100"
            >
              <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden>
                <path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          )}
        </div>
      </div>
      {open && (
        <ul className="mb-2 ml-[7.5rem] mr-3 space-y-1 border-l border-white/[0.06] pl-4">
          {e.items.map((a) => (
            <li key={a.signature} className="flex flex-wrap items-center gap-2 py-1 text-xs">
              <span className="w-12 tabular-nums text-ink-3">{timeWib(a.ts)}</span>
              {allDeltas(a).map((c) => (
                <TokenChip key={c.mint} d={c} info={info} />
              ))}
              <a href={`https://solscan.io/tx/${a.signature}`} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[11px] text-accent/80 hover:text-accent">
                {shortAddress(a.signature)} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function DaySummary({ entries, info }: { entries: Entry[]; info: Record<string, TokenInfo> }) {
  const claimed = entries.filter((e) => e.kind === "claim").reduce((n, e) => n + (describe(e, info).value ?? 0), 0);
  const count = (k: string) => entries.filter((e) => e.kind === k).reduce((n, e) => n + e.items.length, 0);
  const pills = [
    claimed > 0 && { text: `Fee +${usd.format(claimed)}`, cls: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20" },
    count("add_liquidity") > 0 && { text: `${count("add_liquidity")} dibuka`, cls: "bg-lime-300/10 text-lime-200 ring-lime-300/20" },
    count("remove_liquidity") > 0 && { text: `${count("remove_liquidity")} ditarik`, cls: "bg-amber-400/10 text-amber-300 ring-amber-400/20" },
    count("swap") > 0 && { text: `${count("swap")} swap`, cls: "bg-cyan-400/10 text-cyan-300 ring-cyan-400/20" },
    count("limit_order_place") + count("limit_order_cancel") > 0 && {
      text: `${count("limit_order_place") + count("limit_order_cancel")} order`,
      cls: "bg-violet-400/10 text-violet-300 ring-violet-400/20",
    },
  ].filter(Boolean) as { text: string; cls: string }[];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {pills.map((p) => (
        <span key={p.text} className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium tabular-nums ring-1 ring-inset ${p.cls}`}>
          {p.text}
        </span>
      ))}
    </div>
  );
}

/** The activity list as a day-by-day timeline: bursts merged, plain sentences, dollar values, noise tucked away. */
export default function ActivityFeed({ items, showNoise }: { items: Activity[]; showNoise: boolean }) {
  const mints = useMemo(() => items.flatMap((a) => [...a.deltas.map((d) => d.mint), SOL_MINT]), [items]);
  const info = useTokenInfo(mints);

  const days = useMemo(() => {
    const entries = group(items).filter((e) => {
      if (showNoise || (e.kind !== "transfer" && e.kind !== "other")) return true;
      const v = e.deltas.map((d) => usdOf(d, info)).reduce<number>((n, x) => n + Math.abs(x ?? 0), 0);
      return v >= NOISE_USD; // a real deposit or withdrawal stays visible; spam and dust do not
    });
    const out: { key: string; ts: number; entries: Entry[] }[] = [];
    for (const e of entries) {
      const k = dayKey(e.ts);
      const last = out[out.length - 1];
      if (last && last.key === k) last.entries.push(e);
      else out.push({ key: k, ts: e.ts, entries: [e] });
    }
    return out;
  }, [items, showNoise, info]);

  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day.key}>
          <div className="sticky top-16 z-10 -mx-1 mb-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-[#0b0e13]/85 px-4 py-2.5 backdrop-blur-xl">
            <h3 className="text-sm font-semibold capitalize tracking-tight text-ink">{dayLabel(day.ts)}</h3>
            <DaySummary entries={day.entries} info={info} />
          </div>
          <ul className="divide-y divide-white/[0.04]">
            {day.entries.map((e) => (
              <Row key={e.id} e={e} info={info} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
