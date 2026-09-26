"use client";

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtNum, shortAddress } from "../../lib/format";

export type NetNode = { id: string; kind: "creator" | "linked" | "busy"; group: number | null };
export type NetLink = { source: string; target: string; kind: "fund" | "send"; sol: number; at: number | null };
export type Network = {
  nodes: NetNode[];
  links: NetLink[];
  groups: { id: number; wallets: string[] }[];
  linked: { wallet: string; creators: string[]; roles: string[]; traced: boolean; group: number | null }[];
  busy: string[];
};

type SimNode = NetNode & SimulationNodeDatum & { r: number };

const W = 900;
const H = 480;
const COLOR = { creator: "#ff5d6c", linked: "#f2b544", busy: "#6b7686" } as const;
const LABEL = { creator: "Pembuat pool berbahaya", linked: "Wallet terkait", busy: "Bursa / layanan ramai" } as const;

function build(net: Network) {
  const nodes: SimNode[] = net.nodes.map((n) => ({ ...n, r: n.kind === "creator" ? 11 : n.kind === "linked" ? 7 : 6 }));
  const links = net.links.map((l) => ({ ...l }));
  const sim = forceSimulation(nodes)
    .force("link", forceLink<SimNode, NetLink>(links as never).id((d) => d.id).distance(60).strength(0.6))
    .force("charge", forceManyBody().strength(-90))
    .force("x", forceX(W / 2).strength(0.05))
    .force("y", forceY(H / 2).strength(0.08))
    .force("collide", forceCollide<SimNode>().radius((d) => d.r + 4))
    .stop()
    .tick(300);
  return { nodes, sim };
}

export default function NetworkMap({ net, selected, onSelect }: { net: Network; selected: string | null; onSelect: (w: string) => void }) {
  const { nodes, sim } = useMemo(() => build(net), [net]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<SimNode | null>(null);
  const dragNode = useRef<SimNode | null>(null);
  const moved = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<SimNode, undefined>>(sim);

  useEffect(() => {
    simRef.current = sim;
    sim.on("tick", () => setTick((t) => t + 1));
    return () => {
      sim.on("tick", null).stop();
    };
  }, [sim]);

  const point = (e: React.PointerEvent) => {
    const box = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - box.left) / box.width) * W, y: ((e.clientY - box.top) / box.height) * H };
  };
  const neighbours = useMemo(() => {
    const focus = hover?.id ?? selected;
    if (!focus) return null;
    const s = new Set([focus]);
    for (const l of net.links) {
      if (l.source === focus) s.add(l.target);
      if (l.target === focus) s.add(l.source);
    }
    return s;
  }, [hover, selected, net.links]);

  if (!nodes.length) {
    return <p className="px-4 py-10 text-center text-sm text-ink-3">Belum ada wallet yang selesai dilacak. Pelacakan berjalan satu wallet tiap ±2 menit.</p>;
  }
  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-label="Peta jaringan aliran dana wallet berbahaya"
        onPointerMove={(e) => {
          const n = dragNode.current;
          if (!n) return;
          moved.current = true;
          const p = point(e);
          n.fx = p.x;
          n.fy = p.y;
          simRef.current.alpha(0.3).restart();
        }}
        onPointerUp={() => {
          const n = dragNode.current;
          dragNode.current = null;
          if (n && !moved.current) onSelect(n.id);
        }}
      >
        <defs>
          <marker id="net-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#8892a0" />
          </marker>
        </defs>
        {net.links.map((l, i) => {
          const a = byId.get(l.source);
          const b = byId.get(l.target);
          if (!a || !b || a.x == null || b.x == null) return null;
          const dx = b.x - a.x;
          const dy = b.y! - a.y!;
          const len = Math.hypot(dx, dy) || 1;
          const dim = neighbours && !(neighbours.has(l.source) && neighbours.has(l.target));
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x - (dx / len) * (b.r + 2)}
              y2={b.y! - (dy / len) * (b.r + 2)}
              stroke={l.kind === "fund" ? "#f2b544" : "#8892a0"}
              strokeWidth={l.kind === "fund" ? 2 : 1.25}
              strokeDasharray={l.kind === "fund" ? undefined : "4 3"}
              opacity={dim ? 0.12 : 0.75}
              markerEnd="url(#net-arrow)"
            />
          );
        })}
        {nodes.map((n) => {
          const dim = neighbours && !neighbours.has(n.id);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              className="cursor-pointer"
              opacity={dim ? 0.25 : 1}
              onPointerDown={(e) => {
                (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture?.(e.pointerId);
                dragNode.current = n;
                moved.current = false;
              }}
              onPointerEnter={() => setHover(n)}
              onPointerLeave={() => setHover(null)}
            >
              <circle r={n.r + 8} fill="transparent" />
              {selected === n.id && <circle r={n.r + 5} fill="none" stroke="#fff" strokeWidth={1.5} opacity={0.8} />}
              <circle r={n.r} fill={COLOR[n.kind]} stroke="#0d1117" strokeWidth={2} />
              {n.kind === "creator" && (
                <text y={n.r + 13} textAnchor="middle" className="fill-ink-2 text-[10px] font-mono">
                  {shortAddress(n.id)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-xl border border-white/10 bg-panel/95 px-3 py-2 text-xs shadow-lg">
          <div className="font-mono font-semibold text-ink">{shortAddress(hover.id)}</div>
          <div className="text-ink-3">
            {LABEL[hover.kind]}
            {hover.group ? ` · jaringan #${hover.group}` : ""}
          </div>
          <div className="mt-1 text-ink-3">
            {net.links.filter((l) => l.source === hover.id || l.target === hover.id).length} aliran ·{" "}
            {fmtNum(net.links.filter((l) => l.source === hover.id || l.target === hover.id).reduce((s, l) => s + l.sol, 0), 2)} SOL
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-line px-4 py-2.5 text-xs text-ink-3">
        {(Object.keys(COLOR) as (keyof typeof COLOR)[]).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR[k] }} aria-hidden />
            {LABEL[k]}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-5 bg-[#f2b544]" aria-hidden />
          mendanai pertama kali
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-5 border-t border-dashed border-[#8892a0]" aria-hidden />
          kirim SOL
        </span>
        <span className="ml-auto">Seret untuk memindah, klik untuk detail</span>
      </div>
    </div>
  );
}
