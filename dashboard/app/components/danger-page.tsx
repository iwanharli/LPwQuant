"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NetworkMap, { type Network } from "./danger/network-map";
import WalletDetail from "./danger/wallet-detail";
import { useAutoRefresh } from "../lib/auto-refresh";
import { ENGINE_URL, fmtDateTime, fmtNum, usd } from "../lib/format";
import PageHeader from "./page-header";
import { SkeletonStrip, SkeletonTable } from "./skeleton";
import TopBar from "./top-bar";

type Event = { pool: string; name: string; kind: "drained" | "suspicious"; at: number; evidence: Record<string, unknown> };
type Wallet = {
  wallet: string;
  drained: number;
  suspicious: number;
  drained_usd: number;
  last_at: number | null;
  events: Event[];
  group: number | null;
  linked: number;
  traced_at: number | null;
  trace: { tx_count: number; tx_count_capped: boolean; first_at: number | null; sol_balance: number | null; funder: { wallet: string; sol: number; busy?: boolean } | null; sent_sol: number } | null;
};
type Report = {
  wallets: Wallet[];
  watched_pools: number;
  network: Network;
  traced: number;
  pending_trace: number;
  rules: { watch_hours: number; min_peak_tvl: number; drain_pct: number };
};
type Tab = "creators" | "linked" | "groups";
const daysSince = (ms: number) => (Date.now() - ms) / 86_400_000;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

export default function DangerPage() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("creators");
  const [query, setQuery] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  const load = useCallback(() => {
    fetch(`${ENGINE_URL}/api/danger-wallets`)
      .then((x) => (x.ok ? x.json() : Promise.reject(x.status)))
      .then((b: Report) => {
        setR(b);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  useAutoRefresh(load, 60_000);
  useEffect(load, [load]);
  const pick = useCallback((w: string) => {
    setSelected(w);
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  const drainedTotal = r?.wallets.reduce((n, w) => n + w.drained_usd, 0) ?? 0;
  const repeat = r?.wallets.filter((w) => w.drained + w.suspicious >= 2).length ?? 0;
  const net = r?.network;
  const q = query.trim();

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader
          title="Wallet"
          accent="berbahaya"
          subtitle="Pembuat pool yang menguras pool-nya atau membuat pool sangat mencurigakan, beserta jaringan dananya: siapa yang mendanai dan ke mana dananya pergi."
        />

        {!r && !error && (
          <>
            <SkeletonStrip count={6} />
            <SkeletonTable rows={6} columns={5} />
          </>
        )}
        {!r && error && <p className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-8 text-sm text-ink-3">Engine tidak bisa dihubungi.</p>}

        {r && net && (
          <>
            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
              <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-3 xl:grid-cols-6">
                <Kpi label="Wallet tercatat" value={String(r.wallets.length)} cls={r.wallets.length ? "text-rose-300" : undefined} hint="pembuat pool berbahaya" />
                <Kpi label="Pelaku berulang" value={String(repeat)} cls={repeat ? "text-rose-300" : undefined} hint="2 kejadian atau lebih" />
                <Kpi label="Jaringan" value={String(net.groups.length)} cls={net.groups.length ? "text-rose-300" : undefined} hint="kelompok pembuat yang saling terhubung" />
                <Kpi label="Wallet terkait" value={String(net.linked.length)} cls={net.linked.length ? "text-amber-300" : undefined} hint="pendana, penerima dana" />
                <Kpi label="Likuiditas dikuras" value={usd.format(drainedTotal)} hint="TVL yang hilang dari pool mereka" />
                <Kpi label="Sudah dilacak" value={`${r.traced}/${r.wallets.length}`} hint={r.pending_trace ? `${r.pending_trace} antre, ±2 mnt per wallet` : `${r.watched_pools} pool baru dipantau`} />
              </div>
            </section>

            <form
              className="flex flex-col gap-2 rounded-2xl border border-white/[0.06] bg-panel p-3 sm:flex-row sm:items-center"
              onSubmit={(e) => {
                e.preventDefault();
                if (BASE58.test(q)) pick(q);
              }}
            >
              <label htmlFor="trace-wallet" className="shrink-0 px-1 text-sm font-medium text-ink-2">
                Lacak wallet
              </label>
              <input
                id="trace-wallet"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Tempel alamat wallet mana pun, misalnya pembuat pool yang kamu curigai"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-sm text-ink placeholder:font-sans placeholder:text-ink-3 focus:border-accent/60 focus:outline-none"
              />
              <button type="submit" disabled={!BASE58.test(q)} className="btn-accent rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-40">
                Lacak
              </button>
            </form>

            {selected && (
              <section ref={detailRef} className="scroll-mt-4 overflow-hidden rounded-2xl border border-rose-500/25 bg-panel">
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-ink">Detail wallet</h2>
                  <button type="button" onClick={() => setSelected(null)} className="text-xs text-ink-3 hover:text-ink" aria-label="Tutup detail">
                    Tutup ✕
                  </button>
                </div>
                <WalletDetail key={selected} wallet={selected} onPick={pick} />
              </section>
            )}

            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
                <h2 className="text-base font-semibold text-ink">Peta jaringan dana</h2>
                <span className="text-xs text-ink-3">
                  {net.nodes.length} wallet · {net.links.length} aliran SOL
                </span>
              </div>
              <NetworkMap net={net} selected={selected} onSelect={pick} />
            </section>

            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel">
              <div className="flex gap-1 border-b border-line px-3 pt-2" role="tablist">
                {(
                  [
                    ["creators", `Pembuat pool (${r.wallets.length})`],
                    ["linked", `Wallet terkait (${net.linked.length})`],
                    ["groups", `Jaringan (${net.groups.length})`],
                  ] as [Tab, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={tab === k}
                    onClick={() => setTab(k)}
                    className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === "creators" &&
                (r.wallets.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-ink-3">Belum ada wallet yang tercatat. Pemantauan berjalan tiap 5 menit.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[860px] text-sm">
                      <thead className="text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                        <tr className="border-b border-line">
                          <th className="px-4 py-2.5 font-medium">#</th>
                          <th className="px-3 py-2.5 font-medium">Wallet</th>
                          <th className="px-3 py-2.5 font-medium">Kejadian</th>
                          <th className="px-3 py-2.5 text-right font-medium">TVL dikuras</th>
                          <th className="px-3 py-2.5 font-medium">Didanai oleh</th>
                          <th className="px-3 py-2.5 text-right font-medium">Umur / transaksi</th>
                          <th className="px-3 py-2.5 font-medium">Jaringan</th>
                          <th className="px-4 py-2.5 text-right font-medium">Terakhir</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.05]">
                        {r.wallets.map((w, i) => (
                          <tr
                            key={w.wallet}
                            onClick={() => pick(w.wallet)}
                            className={`cursor-pointer hover:bg-white/[0.03] ${selected === w.wallet ? "bg-rose-500/[0.06]" : ""}`}
                          >
                            <td className="px-4 py-3">
                              <span className="grid h-7 w-7 place-items-center rounded-full bg-rose-500/15 text-xs font-bold text-rose-300">{i + 1}</span>
                            </td>
                            <td className="px-3 py-3 font-mono font-semibold text-ink">{short(w.wallet)}</td>
                            <td className="px-3 py-3">
                              <div className="flex flex-wrap gap-1.5">
                                {w.drained > 0 && <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-300">{w.drained}× dikuras</span>}
                                {w.suspicious > 0 && <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">{w.suspicious}× mencurigakan</span>}
                              </div>
                            </td>
                            <td className={`px-3 py-3 text-right font-semibold tabular-nums ${w.drained_usd ? "text-rose-300" : "text-ink-3"}`}>{usd.format(w.drained_usd)}</td>
                            <td className="px-3 py-3">
                              {!w.trace ? (
                                <span className="text-xs text-ink-3">{w.traced_at ? "gagal dilacak" : "antre dilacak"}</span>
                              ) : w.trace.funder ? (
                                <span>
                                  <span className="font-mono text-ink-2">{short(w.trace.funder.wallet)}</span>
                                  <span className="block text-[11px] text-ink-3">
                                    {fmtNum(w.trace.funder.sol, 2)} SOL{w.trace.funder.busy ? " · dari bursa" : ""}
                                  </span>
                                </span>
                              ) : (
                                <span className="text-xs text-ink-3">tidak ditemukan</span>
                              )}
                            </td>
                            <td className="px-3 py-3 text-right text-xs text-ink-2 tabular-nums">
                              {w.trace ? (
                                <>
                                  {w.trace.first_at ? `${fmtNum(daysSince(w.trace.first_at), 0)} hari` : "lama"}
                                  <span className="block text-ink-3">
                                    {fmtNum(w.trace.tx_count, 0)}
                                    {w.trace.tx_count_capped ? "+" : ""} tx
                                  </span>
                                </>
                              ) : (
                                "–"
                              )}
                            </td>
                            <td className="px-3 py-3 text-xs">
                              {w.group ? <span className="rounded-full bg-rose-500/10 px-2 py-0.5 font-semibold text-rose-200">#{w.group}</span> : null}
                              {w.linked ? <span className="ml-1.5 text-amber-300">{w.linked} terkait</span> : !w.group ? <span className="text-ink-3">–</span> : null}
                            </td>
                            <td className="px-4 py-3 text-right text-xs text-ink-3">{w.last_at ? fmtDateTime(w.last_at) : "–"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}

              {tab === "linked" &&
                (net.linked.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-ink-3">Belum ada wallet terkait. Muncul setelah pembuat pool selesai dilacak.</p>
                ) : (
                  <ul className="divide-y divide-white/[0.05]">
                    {net.linked.map((l) => (
                      <li key={l.wallet}>
                        <button type="button" onClick={() => pick(l.wallet)} className="grid w-full gap-1 px-4 py-3 text-left text-sm hover:bg-white/[0.03] md:grid-cols-[1fr_1.4fr_auto] md:items-center">
                          <span className="font-mono font-semibold text-ink">{short(l.wallet)}</span>
                          <span className="text-ink-2">
                            {l.roles.join(", ")} untuk {l.creators.length} pembuat: <span className="font-mono text-ink-3">{l.creators.map(short).join(", ")}</span>
                          </span>
                          <span className="text-xs text-ink-3">{l.group ? `jaringan #${l.group}` : ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ))}

              {tab === "groups" &&
                (net.groups.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-ink-3">Belum ada pembuat pool yang terbukti saling terhubung.</p>
                ) : (
                  <ul className="divide-y divide-white/[0.05]">
                    {net.groups.map((g) => {
                      const members = r.wallets.filter((w) => g.wallets.includes(w.wallet));
                      const lost = members.reduce((s, w) => s + w.drained_usd, 0);
                      const hubs = net.linked.filter((l) => l.group === g.id && l.creators.length > 1);
                      return (
                        <li key={g.id} className="px-4 py-3 text-sm">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="font-semibold text-ink">
                              Jaringan #{g.id} · {g.wallets.length} pembuat pool
                            </span>
                            <span className="text-xs text-ink-3">TVL dikuras {usd.format(lost)}</span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            {g.wallets.map((w) => (
                              <button key={w} type="button" onClick={() => pick(w)} className="rounded-lg bg-rose-500/10 px-2 py-1 font-mono text-xs text-rose-200 hover:bg-rose-500/20">
                                {short(w)}
                              </button>
                            ))}
                          </div>
                          {hubs.length > 0 && (
                            <div className="mt-1.5 text-xs text-ink-3">
                              Dihubungkan oleh: {hubs.map((h) => `${short(h.wallet)} (${h.roles.join(", ")})`).join(" · ")}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ))}
            </section>

            <details className="rounded-2xl border border-white/[0.06] bg-panel px-4 py-3 text-sm leading-6 text-ink-3">
              <summary className="cursor-pointer font-medium text-ink-2">Cara kerja dan batasannya</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  Setiap pool baru dipantau {r.rules.watch_hours} jam pertama. Pembuatnya (dibaca dari akun pool on-chain) masuk daftar bila TVL pool pernah ≥{" "}
                  {usd.format(r.rules.min_peak_tvl)} lalu turun di bawah {r.rules.drain_pct}% dari puncaknya, atau bila pool-nya punya 2+ tanda sangat mencurigakan.
                </li>
                <li>
                  Tiap wallet di daftar dilacak on-chain: siapa yang pertama kali mengirim SOL kepadanya (dari 12 transaksi paling awal), lalu ke mana ia
                  mengirim dan dari mana ia menerima SOL dalam 80 transaksi terakhir. Pendana pertamanya ikut dilacak satu langkah ke belakang.
                </li>
                <li>
                  Wallet dengan ≥1000 transaksi dalam seminggu dianggap bursa atau layanan (bot, router). Wallet seperti itu tetap ditampilkan tapi tidak
                  pernah dipakai untuk menghubungkan dua pembuat, karena ribuan orang memakai alamat yang sama.
                </li>
                <li>Pembuat yang berbagi pendana atau saling kirim dana menjadi satu jaringan. Pool baru dari wallet terkait ikut diberi tanda bahaya di screener.</li>
                <li>
                  Yang tercatat adalah pembuat pool; kalau likuiditasnya milik orang lain, pembuat belum tentu yang menariknya. Pelacakan hanya membaca
                  kiriman SOL, belum kiriman token.
                </li>
              </ul>
            </details>
          </>
        )}
      </main>
    </div>
  );
}
