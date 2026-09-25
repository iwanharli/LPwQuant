import { pg } from "./db";
import type { PoolSnapshot } from "./meteora";
import { redis } from "./redis";
import { apiFetch } from "./rpc";

export const SECURITY_KEY = "security:latest"; // hash: mint -> TokenSecurity JSON (read by engine)

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

const REPORT_URL = "https://api.rugcheck.xyz/v1/tokens";
const TTL_MS = 30 * 60_000;
const REQUEST_GAP_MS = 1_500; // public API, stay polite
const RATE_LIMIT_BACKOFF_MS = 60_000;
const LOAD_MAX_AGE_HOURS = 24;

export interface TokenSecurity {
  mint: string;
  fetched_at: number;
  score_normalised: number | null;
  rugged: boolean;
  mint_authority: boolean;
  freeze_authority: boolean;
  /** Top 10 holders excluding known AMM pools and lockers. */
  top10_pct: number | null;
  insiders_detected: number;
  total_holders: number | null;
  lp_locked_pct: number | null;
  /** Token-2022 transfer fee, % of every transfer (null: not a Token-2022 fee token). */
  transfer_fee_pct: number | null;
  /** Someone can still change the transfer fee (a fee config authority is set). */
  transfer_fee_mutable: boolean;
  /** Largest group of wallets linked by transfers of this token (RugCheck insider graph): % of supply it holds,
   * and how many wallets it spans. Null when the graph could not be read. */
  cluster_pct: number | null;
  cluster_size: number | null;
  danger_count: number;
  warn_count: number;
  risks: { name: string; level: string; description?: string }[];
}

interface RugcheckReport {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  rugged?: boolean;
  score_normalised?: number;
  totalHolders?: number;
  graphInsidersDetected?: number;
  risks?: { name: string; level: string; description?: string }[] | null;
  knownAccounts?: Record<string, { name: string; type: string }> | null;
  token?: { supply?: number } | null;
  topHolders?: { address?: string; owner?: string; pct?: number }[] | null;
  markets?: { lp?: { lpLockedPct?: number } | null }[] | null;
  token_extensions?: {
    transferFeeConfig?: {
      transferFeeConfigAuthority?: string | null;
      newerTransferFee?: { transferFeeBasisPoints?: number } | null;
      olderTransferFee?: { transferFeeBasisPoints?: number } | null;
    } | null;
  } | string | null;
}

type InsiderGraph = { nodes?: { id: string; holdings?: number }[]; links?: { source: string; target: string }[] }[];

/** Union the graph's linked wallets and return the group holding the most supply. Pools and lockers are skipped. */
export function largestCluster(graph: InsiderGraph, supply: number, skip: Set<string>): { pct: number; size: number } {
  const parent = new Map<string, string>();
  const holdings = new Map<string, number>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const add = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  for (const net of graph) {
    for (const n of net.nodes ?? []) {
      add(n.id);
      holdings.set(n.id, Math.max(holdings.get(n.id) ?? 0, n.holdings ?? 0));
    }
    for (const l of net.links ?? []) {
      add(l.source);
      add(l.target);
      const a = find(l.source);
      const b = find(l.target);
      if (a !== b) parent.set(a, b);
    }
  }
  const groups = new Map<string, { held: number; size: number }>();
  for (const id of parent.keys()) {
    const g = groups.get(find(id)) ?? { held: 0, size: 0 };
    g.size += 1;
    if (!skip.has(id)) g.held += holdings.get(id) ?? 0;
    groups.set(find(id), g);
  }
  let best = { pct: 0, size: 0 };
  for (const g of groups.values()) {
    const pct = supply > 0 ? (g.held / supply) * 100 : 0;
    if (g.size >= 2 && pct > best.pct) best = { pct, size: g.size };
  }
  return best;
}

const NO_AUTHORITY = new Set(["", "11111111111111111111111111111111"]);

/** The fee from the mint's Token-2022 extension. RugCheck's own `transferFee.pct` reads 0 for tokens that do charge
 * (GP, 3%, on 2026-09-25), so the extension is read directly; the higher of the current and scheduled fee counts. */
function transferFee(report: RugcheckReport): { pct: number | null; mutable: boolean } {
  const ext = typeof report.token_extensions === "object" ? report.token_extensions : null;
  const cfg = ext?.transferFeeConfig;
  if (!cfg) return { pct: null, mutable: false };
  const bps = Math.max(cfg.newerTransferFee?.transferFeeBasisPoints ?? 0, cfg.olderTransferFee?.transferFeeBasisPoints ?? 0);
  return { pct: bps / 100, mutable: !NO_AUTHORITY.has(cfg.transferFeeConfigAuthority ?? "") };
}

export function baseMint(pool: PoolSnapshot): string {
  return QUOTE_MINTS.has(pool.token_x.mint) && !QUOTE_MINTS.has(pool.token_y.mint)
    ? pool.token_y.mint
    : pool.token_x.mint;
}

export function normalizeReport(mint: string, report: RugcheckReport, fetchedAt: number, graph?: InsiderGraph | null): TokenSecurity {
  const known = report.knownAccounts ?? {};
  const isPoolOrLocker = (address?: string) =>
    !!address && (known[address]?.type === "AMM" || known[address]?.type === "LOCKER");
  const holders = (report.topHolders ?? []).filter((h) => !isPoolOrLocker(h.owner) && !isPoolOrLocker(h.address));
  const risks = (report.risks ?? []).map((r) => ({ name: r.name, level: r.level, description: r.description }));
  const lpLocked = (report.markets ?? [])
    .map((m) => m.lp?.lpLockedPct)
    .filter((v): v is number => typeof v === "number");
  const fee = transferFee(report);
  const pools = new Set(Object.entries(known).filter(([, k]) => k.type === "AMM" || k.type === "LOCKER").map(([a]) => a));
  const cluster = graph ? largestCluster(graph, Number(report.token?.supply ?? 0), pools) : null;

  return {
    mint,
    fetched_at: fetchedAt,
    score_normalised: report.score_normalised ?? null,
    rugged: report.rugged ?? false,
    mint_authority: !!report.mintAuthority,
    freeze_authority: !!report.freezeAuthority,
    top10_pct: report.topHolders ? holders.slice(0, 10).reduce((sum, h) => sum + (h.pct ?? 0), 0) : null,
    insiders_detected: report.graphInsidersDetected ?? 0,
    total_holders: report.totalHolders ?? null,
    lp_locked_pct: lpLocked.length ? Math.max(...lpLocked) : null,
    transfer_fee_pct: fee.pct,
    transfer_fee_mutable: fee.mutable,
    // Above 100% the graph and the supply disagree (seen on large tokens with exchange networks): unknown, not huge.
    cluster_pct: cluster && cluster.pct <= 100 ? cluster.pct : null,
    cluster_size: cluster ? cluster.size : null,
    danger_count: risks.filter((r) => r.level === "danger").length,
    warn_count: risks.filter((r) => r.level === "warn").length,
    risks,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Background queue that keeps RugCheck data fresh for the base token of every tracked pool. */
export class SecurityFetcher {
  private readonly cache = new Map<string, TokenSecurity>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  private stopped = false;

  get known(): number {
    return this.cache.size;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Warm the cache from Postgres so restarts don't refetch everything. */
  async load(): Promise<void> {
    const { rows } = await pg.query<{ data: TokenSecurity }>(
      `select data from token_security where fetched_at > now() - make_interval(hours => $1)`,
      [LOAD_MAX_AGE_HOURS],
    );
    for (const { data } of rows) this.cache.set(data.mint, data);
    if (rows.length > 0) {
      await redis.hset(SECURITY_KEY, Object.fromEntries(rows.map(({ data }) => [data.mint, JSON.stringify(data)])));
    }
  }

  /** Queue stale or missing mints, in pool order (highest volume first). */
  enqueue(pools: PoolSnapshot[]): void {
    const now = Date.now();
    for (const pool of pools) {
      const mint = baseMint(pool);
      const cached = this.cache.get(mint);
      if (this.queued.has(mint) || (cached && now - cached.fetched_at < TTL_MS)) continue;
      this.queue.push(mint);
      this.queued.add(mint);
    }
    if (!this.running) void this.drain();
  }

  /** Never-checked mints of brand-new pools go straight to the front: their alert waits on this check, and in
   * volume order they would sit behind every established pool. */
  enqueueFirst(pools: PoolSnapshot[]): void {
    const fresh = pools.map(baseMint).filter((m) => !this.cache.has(m));
    for (const mint of fresh.reverse()) {
      const at = this.queue.indexOf(mint);
      if (at > 0) this.queue.splice(at, 1);
      // Index 1, not 0: the drain loop is working on queue[0] and removes it when done.
      if (at !== 0) this.queue.splice(this.running && this.queue.length ? 1 : 0, 0, mint);
      this.queued.add(mint);
    }
    if (!this.running) void this.drain();
  }

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (!this.stopped && this.queue.length > 0) {
      const mint = this.queue[0];
      try {
        const res = await apiFetch("rugcheck", "report", `${REPORT_URL}/${mint}/report`, { signal: AbortSignal.timeout(30_000) });
        if (res.status === 429) {
          console.warn("[security] rugcheck rate limited, backing off");
          await sleep(RATE_LIMIT_BACKOFF_MS);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const report = (await res.json()) as RugcheckReport;
        // The transfer graph is a second call; without it the report still saves, with the cluster unknown.
        let graph: InsiderGraph | null = null;
        try {
          await sleep(REQUEST_GAP_MS);
          const g = await apiFetch("rugcheck", "graph", `${REPORT_URL}/${mint}/insiders/graph`, { signal: AbortSignal.timeout(30_000) });
          if (g.ok) graph = ((await g.json()) as InsiderGraph | null) ?? [];
        } catch {
          graph = null;
        }
        await this.save(normalizeReport(mint, report, Date.now(), graph));
      } catch (err) {
        // Dropped from the queue; the next poll re-enqueues it because it is still missing/stale.
        console.error(`[security] ${mint} failed: ${err instanceof Error ? err.message : err}`);
      }
      this.queue.shift();
      this.queued.delete(mint);
      await sleep(REQUEST_GAP_MS);
    }
    this.running = false;
  }

  private async save(security: TokenSecurity): Promise<void> {
    this.cache.set(security.mint, security);
    await pg.query(
      `insert into token_security (mint, fetched_at, data) values ($1, to_timestamp($2::float8 / 1000), $3)
       on conflict (mint) do update set fetched_at = excluded.fetched_at, data = excluded.data`,
      [security.mint, security.fetched_at, JSON.stringify(security)],
    );
    await redis.hset(SECURITY_KEY, security.mint, JSON.stringify(security));
  }
}
