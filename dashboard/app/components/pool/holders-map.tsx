"use client";

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { ENGINE_URL, fmtNum, shortAddress } from "../../lib/format";
import { SkeletonBox } from "../skeleton";

type HolderNode = { id: string; pct: number; insider: boolean; kind: "wallet" | "pool"; label: string | null; cluster?: number };
type Cluster = { id: number; size: number; holding: number; pct: number };
type HoldersData = {
  mint: string;
  fetched_at: number;
  nodes: HolderNode[];
  links: { source: string; target: string }[];
  clusters: Cluster[];
  summary: {
    top10_pct: number;
    insider_pct: number;
    clustered_pct: number;
    largest_cluster: { pct: number; holding: number; size: number } | null;
    total_holders: number | null;
  };
};

type SimNode = HolderNode & SimulationNodeDatum & { r: number };

const W = 760;
const H = 440;
// Clusters in order of how much they hold: the biggest one reads as the warning it is.
const CLUSTER_COLORS = ["#ff5d6c", "#f59e5b", "#e05ea8", "#f2c744", "#9b8cff", "#2ec4b6", "#c9a27a", "#ff8fb1"];
const WALLET = "#4a9eff";
const POOL = "#6b7686";

function color(n: HolderNode): string {
  if (n.kind === "pool") return POOL;
  if (n.cluster != null) return CLUSTER_COLORS[n.cluster % CLUSTER_COLORS.length];
  return WALLET;
}

const radius = (pct: number) => 3 + Math.sqrt(Math.max(0, pct)) * 11;

/** Lay the bubbles out once per dataset: a static force layout, so nothing jitters while you read it. */
function layout(data: HoldersData) {
  const nodes: SimNode[] = data.nodes.map((n) => ({ ...n, r: radius(n.pct) }));
  const links = data.links.map((l) => ({ ...l }));
  const sim = forceSimulation(nodes)
    .force("link", forceLink<SimNode, { source: string; target: string }>(links).id((d) => d.id).distance((l) => 18 + (l.source as unknown as SimNode).r + (l.target as unknown as SimNode).r).strength(0.7))
    .force("charge", forceManyBody().strength(-28))
    .force("x", forceX(W / 2).strength(0.06))
    .force("y", forceY(H / 2).strength(0.09))
    .force("collide", forceCollide<SimNode>().radius((d) => d.r + 2).strength(1))
    .stop()
    .tick(320);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines = data.links
    .map((l) => [byId.get(l.source), byId.get(l.target)] as const)
    .filter((p): p is readonly [SimNode, SimNode] => !!p[0] && !!p[1]);
  return { nodes, lines, sim };
}

function useHolders(mint: string | null) {
  const [state, setState] = useState<{ mint: string | null; data: HoldersData | null; error: string | null }>({ mint: null, data: null, error: null });
  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    fetch(`${ENGINE_URL}/api/tokens/${mint}/holders`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: HoldersData) => !cancelled && setState({ mint, data: d, error: null }))
      .catch((e: Error) => !cancelled && setState({ mint, data: null, error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [mint]);
  return state.mint === mint ? state : { mint, data: null, error: null };
}

function Stat({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${cls ?? "text-ink"}`}>{value}</div>
      {hint && <div className="text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

export default function HoldersMap({ mint, symbol }: { mint: string | null; symbol: string }) {
  const { data, error } = useHolders(mint);
  const laid = useMemo(() => (data ? layout(data) : null), [data]);
  // Dragging a bubble wakes the simulation so its linked wallets follow; each tick re-renders the positions.
  const [, setTick] = useState(0);
  const dragNode = useRef<SimNode | null>(null);
  useEffect(() => {
    const sim: Simulation<SimNode, undefined> | undefined = laid?.sim;
    if (!sim) return;
    sim.on("tick", () => setTick((t) => t + 1));
    return () => {
      sim.stop();
      sim.on("tick", null);
    };
  }, [laid]);
  const toGraph = (e: { clientX: number; clientY: number }) => {
    const box = svgRef.current!.getBoundingClientRect();
    return { x: (((e.clientX - box.left) / box.width) * W - view.x) / view.k, y: (((e.clientY - box.top) / box.height) * H - view.y) / view.k };
  };
  const [hover, setHover] = useState<SimNode | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const moved = useRef<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Wheel zoom around the pointer; passive listeners cannot preventDefault, so it is attached by hand.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = svg.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      const py = ((e.clientY - box.top) / box.height) * H;
      setView((v) => {
        const k = Math.min(6, Math.max(0.6, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [laid]);

  const s = data?.summary;
  const largest = s?.largest_cluster;
  const holders = data?.nodes.filter((n) => n.kind === "wallet" && n.pct > 0).length ?? 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-panel shadow-[0_14px_42px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Peta pemegang {symbol}</h2>
          <p className="text-xs text-ink-3">Gelembung = wallet (besar = porsi supply). Garis = pernah saling transfer token ini.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: CLUSTER_COLORS[0] }} /> Kelompok terbesar</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: CLUSTER_COLORS[1] }} /> Kelompok lain</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: WALLET, opacity: 0.6 }} /> Wallet sendiri</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: POOL }} /> Pool / locker</span>
        </div>
      </div>

      {!mint && <p className="px-4 py-10 text-center text-sm text-ink-3">Alamat token belum diketahui.</p>}
      {mint && error && (
        <p className="px-4 py-10 text-center text-sm text-ink-3">
          Peta pemegang belum tersedia ({error}). Token yang baru beberapa menit biasanya belum dianalisis RugCheck.
        </p>
      )}
      {mint && !error && !laid && (
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <SkeletonBox className="h-[440px] w-full rounded-xl" />
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <SkeletonBox key={i} className="h-16 w-full rounded-xl" />)}</div>
        </div>
      )}

      {laid && data && s && (
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="relative overflow-hidden rounded-xl border border-white/[0.05] bg-bg/60">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              className="h-[440px] w-full cursor-grab touch-none select-none active:cursor-grabbing"
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture?.(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
              }}
              onPointerMove={(e) => {
                const n = dragNode.current;
                if (n) {
                  const p = toGraph(e);
                  n.fx = p.x;
                  n.fy = p.y;
                  return;
                }
                const d = drag.current;
                const svg = svgRef.current;
                if (!d || !svg) return;
                const scale = W / svg.getBoundingClientRect().width;
                setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x) * scale, y: d.vy + (e.clientY - d.y) * scale }));
              }}
              onPointerUp={() => {
                drag.current = null;
                const n = dragNode.current;
                if (n) {
                  n.fx = null;
                  n.fy = null;
                  laid.sim.alphaTarget(0);
                  dragNode.current = null;
                }
              }}
              onPointerLeave={() => (drag.current = null)}
            >
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {laid.lines.map(([a, b], i) => {
                  const dim = focus != null && a.cluster !== focus;
                  return (
                    <line
                      key={i}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={a.cluster != null ? CLUSTER_COLORS[a.cluster % CLUSTER_COLORS.length] : "#ffffff"}
                      strokeOpacity={dim ? 0.06 : 0.45}
                      strokeWidth={1.2 / view.k}
                    />
                  );
                })}
                {laid.nodes.map((n) => {
                  const dim = focus != null && n.cluster !== focus;
                  const c = color(n);
                  return (
                    <circle
                      key={n.id}
                      cx={n.x} cy={n.y} r={n.r}
                      fill={c}
                      fillOpacity={dim ? 0.08 : n.cluster != null || n.kind === "pool" ? 0.85 : 0.5}
                      stroke={hover?.id === n.id ? "#ffffff" : c}
                      strokeOpacity={dim ? 0.1 : 1}
                      strokeWidth={(hover?.id === n.id ? 2 : 1) / view.k}
                      className="cursor-grab active:cursor-grabbing"
                      onPointerEnter={() => setHover(n)}
                      onPointerLeave={() => setHover((h) => (h?.id === n.id ? null : h))}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        svgRef.current?.setPointerCapture(e.pointerId);
                        dragNode.current = n;
                        moved.current = { x: e.clientX, y: e.clientY };
                        const p = toGraph(e);
                        n.fx = p.x;
                        n.fy = p.y;
                        laid.sim.alphaTarget(0.3).restart();
                      }}
                      onClick={(e) => {
                        // A drag ends in a click too; only a click that barely moved opens Solscan.
                        const m = moved.current;
                        if (m && Math.hypot(e.clientX - m.x, e.clientY - m.y) > 4) return;
                        window.open(`https://solscan.io/account/${n.id}`, "_blank", "noopener");
                      }}
                    />
                  );
                })}
              </g>
            </svg>
            {hover && (
              <div className="pointer-events-none absolute left-3 top-3 max-w-[260px] rounded-lg border border-white/[0.1] bg-panel/95 px-3 py-2 text-xs shadow-lg shadow-black/40">
                <div className="font-mono text-ink">{shortAddress(hover.id)}</div>
                <div className="mt-0.5 tabular-nums text-ink-2">{fmtNum(hover.pct, 2)}% supply</div>
                <div className="mt-0.5 text-ink-3">
                  {hover.kind === "pool"
                    ? `Pool / locker${hover.label ? ` · ${hover.label}` : ""}`
                    : hover.cluster != null
                      ? `Kelompok #${hover.cluster + 1} · ${data.clusters[hover.cluster].size} wallet`
                      : "Wallet sendiri"}
                  {hover.insider && hover.kind === "wallet" ? " · insider" : ""}
                </div>
                <div className="mt-1 text-[11px] text-ink-3">Seret untuk memindah · klik untuk buka di Solscan</div>
              </div>
            )}
            <div className="absolute bottom-2 right-2 flex gap-1">
              {[
                ["+", () => setView((v) => ({ ...v, k: Math.min(6, v.k * 1.25) }))],
                ["−", () => setView((v) => ({ ...v, k: Math.max(0.6, v.k / 1.25) }))],
                ["⟲", () => setView({ x: 0, y: 0, k: 1 })],
              ].map(([t, f]) => (
                <button
                  key={t as string}
                  type="button"
                  onClick={f as () => void}
                  className="h-7 w-7 rounded-md border border-white/[0.08] bg-panel/90 text-sm text-ink-2 hover:text-ink"
                >
                  {t as string}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            <Stat
              label="Kelompok terbesar"
              value={largest ? `${fmtNum(largest.pct, 1)}%` : "Tidak ada"}
              hint={largest ? `${largest.size} wallet saling terhubung, ${largest.holding} masih memegang` : "tidak ditemukan wallet yang saling transfer"}
              cls={largest && largest.pct >= 10 ? "text-rose-300" : largest && largest.pct >= 5 ? "text-amber-300" : "text-ink"}
            />
            <Stat
              label="Top 10 (tanpa pool)"
              value={`${fmtNum(s.top10_pct, 1)}%`}
              hint={s.total_holders ? `dari ${fmtNum(s.total_holders)} holder` : undefined}
              cls={s.top10_pct >= 50 ? "text-rose-300" : s.top10_pct >= 30 ? "text-amber-300" : "text-ink"}
            />
            <Stat label="Dipegang kelompok" value={`${fmtNum(s.clustered_pct, 1)}%`} hint={`${data.clusters.length} kelompok · ${holders} wallet ditampilkan`} />

            {data.clusters.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
                <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Kelompok · klik untuk sorot</div>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                  {data.clusters.slice(0, 8).map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setFocus((f) => (f === c.id ? null : c.id))}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs tabular-nums transition-colors ${
                          focus === c.id ? "bg-white/[0.07] text-ink" : "text-ink-2 hover:bg-white/[0.04]"
                        }`}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CLUSTER_COLORS[c.id % CLUSTER_COLORS.length] }} />
                        <span className="flex-1 text-left">#{c.id + 1} · {c.size} wallet</span>
                        <span>{fmtNum(c.pct, 1)}%</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="px-1 text-[11px] leading-4 text-ink-3">
              Sumber RugCheck: 20 pemegang terbesar dan jaringan transfer antar wallet. Diperbarui tiap 30 menit.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
