import { pg } from "./db";
import type { PoolSnapshot } from "./meteora";
import { redis } from "./redis";

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
  topHolders?: { address?: string; owner?: string; pct?: number }[] | null;
  markets?: { lp?: { lpLockedPct?: number } | null }[] | null;
}

export function baseMint(pool: PoolSnapshot): string {
  return QUOTE_MINTS.has(pool.token_x.mint) && !QUOTE_MINTS.has(pool.token_y.mint)
    ? pool.token_y.mint
    : pool.token_x.mint;
}

export function normalizeReport(mint: string, report: RugcheckReport, fetchedAt: number): TokenSecurity {
  const known = report.knownAccounts ?? {};
  const isPoolOrLocker = (address?: string) =>
    !!address && (known[address]?.type === "AMM" || known[address]?.type === "LOCKER");
  const holders = (report.topHolders ?? []).filter((h) => !isPoolOrLocker(h.owner) && !isPoolOrLocker(h.address));
  const risks = (report.risks ?? []).map((r) => ({ name: r.name, level: r.level, description: r.description }));
  const lpLocked = (report.markets ?? [])
    .map((m) => m.lp?.lpLockedPct)
    .filter((v): v is number => typeof v === "number");

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

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (!this.stopped && this.queue.length > 0) {
      const mint = this.queue[0];
      try {
        const res = await fetch(`${REPORT_URL}/${mint}/report`, { signal: AbortSignal.timeout(30_000) });
        if (res.status === 429) {
          console.warn("[security] rugcheck rate limited, backing off");
          await sleep(RATE_LIMIT_BACKOFF_MS);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await this.save(normalizeReport(mint, (await res.json()) as RugcheckReport, Date.now()));
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
