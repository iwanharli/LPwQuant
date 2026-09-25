/**
 * New-pool feed: the newest Meteora pools every NEW_POOL_POLL_SEC, so a pool reaches the screener (and its safety
 * checks, and the Telegram alert) about a minute after it is created instead of hours later.
 *
 * Only pools with some liquidity are kept (NEW_POOL_MIN_TVL): most new pools are empty or a few dollars and never
 * trade. A kept pool stays tracked for FRESH_HOURS; after that it is on its own under the normal volume filter.
 */
import { config } from "./config";
import { fetchNewestPools, type PoolSnapshot } from "./meteora";

const FRESH_HOURS = 6;

export class NewPoolFeed {
  private readonly fresh = new Map<string, PoolSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private firstRun = true;
  found = 0;

  /** `onNew` runs when a pool is seen for the first time, so the caller can refresh without waiting a full cycle. */
  constructor(private readonly onNew: (pools: PoolSnapshot[]) => void) {}

  start(): void {
    const tick = () => void this.tick().catch((err) => console.warn("[new-pools] failed", err instanceof Error ? err.message : err));
    tick();
    this.timer = setInterval(tick, config.newPoolPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** A pool found on chain before the API lists it: tracked the same way, announced at once. */
  addOnchain(p: PoolSnapshot): void {
    if (this.fresh.has(p.address)) return;
    this.fresh.set(p.address, p);
    this.found += 1;
    console.log(`[new-pools] 1 pool baru (on-chain): ${p.name}`);
    this.onNew([p]);
  }

  /** Pools created within FRESH_HOURS with enough liquidity, freshest data first. */
  current(): PoolSnapshot[] {
    return [...this.fresh.values()];
  }

  async tick(): Promise<void> {
    const now = Date.now();
    const newest = await fetchNewestPools();
    const added: PoolSnapshot[] = [];
    for (const p of newest) {
      const created = p.pool_created_at ?? 0;
      if (!created || now - created > FRESH_HOURS * 3_600_000) continue;
      if (p.tvl < config.newPoolMinTvl) continue;
      if (!this.fresh.has(p.address)) added.push(p);
      this.fresh.set(p.address, p);
    }
    for (const [address, p] of this.fresh) {
      if (now - (p.pool_created_at ?? 0) > FRESH_HOURS * 3_600_000) this.fresh.delete(address);
    }
    // The first run finds whatever already exists; only later finds are "new" and worth an early refresh.
    if (added.length && !this.firstRun) {
      this.found += added.length;
      console.log(`[new-pools] ${added.length} pool baru: ${added.map((p) => p.name).join(", ")}`);
      this.onNew(added);
    }
    this.firstRun = false;
  }
}
