"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ENGINE_URL, fmtDateTime, fmtNum, shortAddress, usd } from "../../lib/format";
import { SkeletonBox } from "../skeleton";

type Flow = { wallet: string; sol: number; n: number; first_at: number | null; last_at: number | null; busy?: boolean };
type Funder = { wallet: string; sol: number; at: number | null; signature: string; busy?: boolean };
type Trace = {
  tx_count: number;
  tx_count_capped: boolean;
  first_at: number | null;
  last_at: number | null;
  sol_balance: number | null;
  funders: Funder[];
  sent_to: Flow[];
  received_from: Flow[];
  scanned: { earliest: number; recent: number };
};
type Linked = { wallet: string; creators: string[]; roles: string[]; traced: boolean; group: number | null };
export type Detail = {
  wallet: string;
  tracing: boolean;
  listed: boolean;
  events: { pool: string; name: string; kind: "drained" | "suspicious"; at: number; evidence: Record<string, unknown> }[];
  pools: { pool: string; name: string; peak_tvl: number; last_tvl: number | null; first_seen: number }[];
  trace: Trace | null;
  trace_error: string | null;
  traced_at: number | null;
  group: number | null;
  group_wallets: string[];
  linked: Linked[];
  linked_to: Linked | null;
  busy: string[];
};

const ago = (ms: number | null) => {
  if (!ms) return "–";
  const d = (Date.now() - ms) / 86_400_000;
  return d < 1 ? `${fmtNum(d * 24, 0)} jam` : d < 60 ? `${fmtNum(d, 0)} hari` : `${fmtNum(d / 30, 0)} bulan`;
};

function Addr({ w, onPick, busy, self }: { w: string; onPick?: (w: string) => void; busy?: boolean; self?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {onPick && !self ? (
        <button type="button" onClick={() => onPick(w)} className="font-mono font-medium text-ink hover:text-accent">
          {shortAddress(w)}
        </button>
      ) : (
        <span className="font-mono font-medium text-ink">{shortAddress(w)}</span>
      )}
      {busy && <span className="rounded-full bg-white/[0.06] px-1.5 py-px text-[10px] text-ink-3">bursa/layanan</span>}
      <a href={`https://solscan.io/account/${w}`} target="_blank" rel="noreferrer" className="text-[11px] text-ink-3 hover:text-accent">
        ↗
      </a>
    </span>
  );
}

function Stat({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-0.5 text-base font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

function FlowTable({ title, hint, rows, onPick }: { title: string; hint: string; rows: Flow[]; onPick: (w: string) => void }) {
  return (
    <div className="rounded-xl border border-white/[0.06]">
      <div className="border-b border-line px-3 py-2">
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="text-[11px] text-ink-3">{hint}</div>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-xs text-ink-3">Tidak ada.</p>
      ) : (
        <ul className="divide-y divide-white/[0.05] text-sm">
          {rows.map((f) => (
            <li key={f.wallet} className="flex items-center justify-between gap-3 px-3 py-2">
              <Addr w={f.wallet} busy={f.busy} onPick={onPick} />
              <span className="text-right tabular-nums">
                <span className="font-semibold text-ink">{fmtNum(f.sol, 2)} SOL</span>
                <span className="block text-[11px] text-ink-3">
                  {f.n}× · {f.last_at ? fmtDateTime(f.last_at) : "–"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type State = { wallet: string; data: Detail | null; error: string | null; tracing: boolean };

function request(w: string, method: "GET" | "POST"): Promise<Detail> {
  return fetch(`${ENGINE_URL}/api/danger-wallets/${w}${method === "POST" ? "/trace" : ""}`, { method }).then((r) =>
    r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail ?? `HTTP ${r.status}`))),
  );
}

export function useDetail(wallet: string) {
  const [state, setState] = useState<State | null>(null);
  const [nonce, setNonce] = useState(0);
  // Load, and while the engine is tracing this wallet in the background, look again every 5 s.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const get = () =>
      request(wallet, "GET")
        .then((d) => {
          if (cancelled) return;
          setState({ wallet, data: d, error: null, tracing: d.tracing });
          if (d.tracing) timer = setTimeout(get, 5000);
        })
        .catch((e: Error) => !cancelled && setState((s) => ({ wallet, data: s?.wallet === wallet ? s.data : null, error: e.message, tracing: false })));
    get();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wallet, nonce]);
  const retrace = useCallback(() => {
    setState((s) => ({ wallet, data: s?.wallet === wallet ? s.data : null, error: null, tracing: true }));
    request(wallet, "POST")
      .then(() => setNonce((n) => n + 1))
      .catch((e: Error) => setState((s) => ({ wallet, data: s?.data ?? null, error: e.message, tracing: false })));
  }, [wallet]);
  const cur = state?.wallet === wallet ? state : { wallet, data: null, error: null, tracing: false };
  return { ...cur, retrace };
}

export default function WalletDetail({ wallet, onPick }: { wallet: string; onPick: (w: string) => void }) {
  const { data: d, error, tracing, retrace } = useDetail(wallet);
  const needsTrace = !!d && !d.trace && !d.traced_at && !tracing;

  if (needsTrace) {
    return (
      <div className="space-y-3 p-4 text-sm">
        <div className="break-all font-mono font-semibold text-ink">{wallet}</div>
        <p className="text-ink-3">
          Wallet ini belum pernah dilacak{d.listed ? "" : " dan tidak ada di daftar"}. Pelacakan membaca riwayat transaksinya on-chain: siapa yang
          mendanainya dan ke mana SOL-nya pergi (1–3 menit).
        </p>
        <button type="button" onClick={retrace} className="btn-accent rounded-xl px-4 py-2 font-semibold">
          Lacak sekarang
        </button>
      </div>
    );
  }
  if (!d) {
    if (tracing) return <p className="p-4 text-sm text-ink-3">Sedang dilacak on-chain (1–3 menit)…</p>;
    return error ? <p className="p-4 text-sm text-rose-300">Gagal memuat: {error}</p> : <SkeletonBox className="m-4 h-48" />;
  }
  const t = d.trace;
  const funder = t?.funders[0];
  const drainedUsd = d.events.filter((e) => e.kind === "drained").reduce((s, e) => s + Math.max(0, Number(e.evidence.peak_tvl ?? 0) - Number(e.evidence.tvl_after ?? 0)), 0);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-sm font-semibold text-ink">{d.wallet}</span>
            {d.listed ? (
              <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-300">Pembuat pool berbahaya</span>
            ) : d.linked_to ? (
              <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">Terkait wallet berbahaya</span>
            ) : (
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-semibold text-ink-3">Tidak di daftar</span>
            )}
            {d.group && <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-200">Jaringan #{d.group}</span>}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            {tracing ? "Sedang dilacak on-chain (1–3 menit)…" : d.traced_at ? `Dilacak ${fmtDateTime(d.traced_at)}` : "Belum dilacak"}
            {d.trace_error && !tracing ? ` · gagal terakhir: ${d.trace_error.slice(0, 80)}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={retrace}
            disabled={tracing}
            className="rounded-lg border border-white/10 px-2.5 py-1.5 font-medium text-ink-2 hover:bg-white/[0.04] disabled:opacity-50"
          >
            {tracing ? "Melacak…" : "Lacak ulang"}
          </button>
          <a href={`https://solscan.io/account/${d.wallet}`} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-accent">
            Solscan ↗
          </a>
        </div>
      </div>

      {d.linked_to && (
        <p className="rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-100">
          {d.linked_to.roles.join(", ") || "berbagi aliran dana"} untuk {d.linked_to.creators.length} pembuat pool berbahaya:{" "}
          {d.linked_to.creators.map((c, i) => (
            <span key={c}>
              {i ? ", " : ""}
              <Addr w={c} onPick={onPick} />
            </span>
          ))}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Umur wallet" value={t?.first_at ? ago(t.first_at) : t?.tx_count_capped ? "lama" : "–"} hint={t?.first_at ? `sejak ${fmtDateTime(t.first_at)}` : undefined} />
        <Stat label="Transaksi" value={t ? `${fmtNum(t.tx_count, 0)}${t.tx_count_capped ? "+" : ""}` : "–"} hint={t?.last_at ? `terakhir ${ago(t.last_at)} lalu` : undefined} />
        <Stat label="Saldo SOL" value={t?.sol_balance != null ? fmtNum(t.sol_balance, 2) : "–"} />
        <Stat label="Pool dibuat" value={String(d.pools.length)} hint={`${d.events.length} kejadian bahaya`} cls={d.events.length ? "text-rose-300" : undefined} />
        <Stat label="TVL dikuras" value={usd.format(drainedUsd)} cls={drainedUsd ? "text-rose-300" : undefined} />
      </div>

      {t && (
        <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.04] px-3 py-2.5 text-sm">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Didanai pertama kali oleh</div>
          {funder ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Addr w={funder.wallet} busy={funder.busy} onPick={onPick} />
              <span className="font-semibold tabular-nums text-ink">{fmtNum(funder.sol, 3)} SOL</span>
              <span className="text-xs text-ink-3">{funder.at ? fmtDateTime(funder.at) : ""}</span>
              {funder.busy && <span className="text-xs text-ink-3">dari bursa: pemilik aslinya tidak bisa dilacak lewat sini</span>}
              {t.funders.length > 1 && <span className="text-xs text-ink-3">+{t.funders.length - 1} pendana awal lain</span>}
            </div>
          ) : (
            <div className="mt-1 text-xs text-ink-3">
              {t.tx_count_capped ? "Riwayat terlalu panjang (>20.000 transaksi) untuk mencari pendana pertama." : "Tidak ada kiriman SOL di transaksi awalnya."}
            </div>
          )}
        </div>
      )}

      {t && (
        <div className="grid gap-3 lg:grid-cols-2">
          <FlowTable title="Mengirim SOL ke" hint={`${t.scanned.recent} transaksi terakhir: ke mana dana keluar`} rows={t.sent_to} onPick={onPick} />
          <FlowTable title="Menerima SOL dari" hint={`${t.scanned.recent} transaksi terakhir`} rows={t.received_from} onPick={onPick} />
        </div>
      )}

      {(d.group_wallets.length > 1 || d.linked.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-2">
          {d.group_wallets.length > 1 && (
            <div className="rounded-xl border border-rose-500/20 px-3 py-2.5">
              <div className="text-sm font-semibold text-ink">Satu jaringan #{d.group}</div>
              <div className="text-[11px] text-ink-3">pembuat pool berbahaya yang berbagi pendana atau saling kirim dana</div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                {d.group_wallets.map((w) => (
                  <Addr key={w} w={w} onPick={onPick} self={w === d.wallet} />
                ))}
              </div>
            </div>
          )}
          {d.linked.length > 0 && (
            <div className="rounded-xl border border-amber-400/20 px-3 py-2.5">
              <div className="text-sm font-semibold text-ink">Wallet terkait ({d.linked.length})</div>
              <div className="text-[11px] text-ink-3">pool baru dari wallet ini ikut diberi tanda bahaya</div>
              <ul className="mt-2 space-y-1.5 text-sm">
                {d.linked.slice(0, 12).map((l) => (
                  <li key={l.wallet} className="flex flex-wrap items-center justify-between gap-2">
                    <Addr w={l.wallet} onPick={onPick} />
                    <span className="text-xs text-ink-3">
                      {l.roles.join(", ")}
                      {l.creators.length > 1 ? ` · ${l.creators.length} pembuat` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {d.events.length > 0 && (
        <div className="rounded-xl border border-white/[0.06]">
          <div className="border-b border-line px-3 py-2 text-sm font-semibold text-ink">Kejadian bahaya</div>
          <ul className="divide-y divide-white/[0.05]">
            {d.events.map((e) => {
              const ev = e.evidence as { peak_tvl?: number; tvl_after?: number; hours_after_seen?: number; signs?: string[] };
              return (
                <li key={`${e.pool}-${e.kind}`} className="grid gap-1 px-3 py-2.5 text-sm md:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/pool/${e.pool}`} className="font-medium text-ink hover:text-accent">
                        {e.name.replace("-", "/")}
                      </Link>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${e.kind === "drained" ? "bg-rose-500/15 text-rose-300" : "bg-amber-400/10 text-amber-300"}`}>
                        {e.kind === "drained" ? "Likuiditas dikuras" : "Pool sangat mencurigakan"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-ink-3">
                      {e.kind === "drained"
                        ? `TVL ${usd.format(ev.peak_tvl ?? 0)} → ${usd.format(ev.tvl_after ?? 0)}${ev.hours_after_seen != null ? ` · ${fmtNum(ev.hours_after_seen, 1)} jam setelah pool terlihat` : ""}`
                        : (ev.signs ?? []).join(" · ")}
                    </div>
                  </div>
                  <div className="text-xs text-ink-3 md:text-right">{fmtDateTime(e.at)}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {d.pools.length > 0 && (
        <div className="rounded-xl border border-white/[0.06]">
          <div className="border-b border-line px-3 py-2 text-sm font-semibold text-ink">Pool yang dibuat (terpantau)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <tr>
                  <th className="px-3 py-2 font-medium">Pool</th>
                  <th className="px-3 py-2 text-right font-medium">TVL puncak</th>
                  <th className="px-3 py-2 text-right font-medium">TVL terakhir</th>
                  <th className="px-3 py-2 text-right font-medium">Terlihat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {d.pools.map((p) => {
                  const drained = p.peak_tvl >= 1000 && (p.last_tvl ?? 0) < p.peak_tvl * 0.1;
                  return (
                    <tr key={p.pool}>
                      <td className="px-3 py-2">
                        <Link href={`/pool/${p.pool}`} className="font-medium text-ink hover:text-accent">
                          {p.name.replace("-", "/")}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd.format(p.peak_tvl)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${drained ? "text-rose-300" : ""}`}>{usd.format(p.last_tvl ?? 0)}</td>
                      <td className="px-3 py-2 text-right text-xs text-ink-3">{fmtDateTime(p.first_seen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
