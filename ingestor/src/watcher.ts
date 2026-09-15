import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { createProgram, decodeAccount, type LbPair } from "@meteora-ag/dlmm";
import { config } from "./config";
import type { PoolSnapshot } from "./meteora";
import { createFailoverFetch, usage } from "./rpc";

export interface PriceTick {
  ts: number;
  address: string;
  slot: number;
  active_id: number;
  price: number;
}

interface WatchedPool {
  subscriptionId: number;
  decimalsX: number;
  decimalsY: number;
  lastActiveId: number | null;
}

/** Subscribes to LbPair accounts and emits a tick whenever the active bin moves. */
export class PoolWatcher {
  private readonly connection: Connection;
  private readonly program: ReturnType<typeof createProgram>;
  private readonly watched = new Map<string, WatchedPool>();
  private buffer: PriceTick[] = [];
  private flushing = false;
  private readonly flushTimer: NodeJS.Timeout;
  private readonly pollTimer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(private readonly onTicks: (ticks: PriceTick[]) => Promise<void>) {
    this.connection = new Connection(config.rpcProviders[0].httpUrl, {
      wsEndpoint: config.wsUrl || undefined,
      commitment: "confirmed",
      fetch: createFailoverFetch(config.rpcProviders),
    });
    this.program = createProgram(this.connection);
    this.flushTimer = setInterval(() => void this.flush(), 2_000);
    if (config.watchMode === "poll") {
      this.pollTimer = setInterval(() => void this.pollAll(), config.watchPollIntervalMs);
    }
  }

  /** poll mode: one getMultipleAccounts call per 100 watched pools. */
  private async pollAll(): Promise<void> {
    if (this.polling || this.watched.size === 0) return;
    this.polling = true;
    try {
      await this.fetchState([...this.watched.keys()]);
    } catch (err) {
      console.error("[watcher] poll failed", err instanceof Error ? err.message : err);
    } finally {
      this.polling = false;
    }
  }

  private async fetchState(addresses: string[]): Promise<void> {
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const { context, value } = await this.connection.getMultipleAccountsInfoAndContext(
        chunk.map((a) => new PublicKey(a)),
      );
      value.forEach((info, idx) => {
        const pool = this.watched.get(chunk[idx]);
        if (info && pool) this.handle(chunk[idx], pool, info, context.slot);
      });
    }
  }

  get size(): number {
    return this.watched.size;
  }

  /** Watch the top-N pools (input is already sorted by volume). */
  async sync(pools: PoolSnapshot[]): Promise<void> {
    const targets = pools.slice(0, config.watchTopN);
    const wanted = new Set(targets.map((p) => p.address));

    for (const [address, pool] of this.watched) {
      if (wanted.has(address)) continue;
      this.watched.delete(address);
      if (pool.subscriptionId < 0) continue;
      await this.connection
        .removeAccountChangeListener(pool.subscriptionId)
        .catch((err) => console.error(`[watcher] unsubscribe ${address}`, err));
    }

    const added = targets.filter((p) => !this.watched.has(p.address));
    for (const p of added) {
      const pool: WatchedPool = {
        subscriptionId: -1,
        decimalsX: p.token_x.decimals,
        decimalsY: p.token_y.decimals,
        lastActiveId: null,
      };
      this.watched.set(p.address, pool);
      if (config.watchMode !== "ws") continue;
      usage.record(config.wsProviderName, "ws_subscribe", "accountSubscribe");
      pool.subscriptionId = this.connection.onAccountChange(
        new PublicKey(p.address),
        (info, ctx) => {
          usage.record(config.wsProviderName, "ws_message", "accountNotification");
          this.handle(p.address, pool, info, ctx.slot);
        },
        "confirmed",
      );
    }

    // Baseline tick for new pools (ws only fires on change; poll would otherwise wait an interval).
    if (added.length > 0) await this.fetchState(added.map((p) => p.address));
  }

  private handle(address: string, pool: WatchedPool, info: AccountInfo<Buffer>, slot: number): void {
    if (this.watched.get(address) !== pool) return; // stale subscription
    let pair: LbPair;
    try {
      pair = decodeAccount<LbPair>(this.program, "lbPair", info.data);
    } catch (err) {
      console.error(`[watcher] decode failed ${address}`, err);
      return;
    }
    if (pair.activeId === pool.lastActiveId) return;
    pool.lastActiveId = pair.activeId;
    const price = Math.pow(1 + pair.binStep / 10_000, pair.activeId) * Math.pow(10, pool.decimalsX - pool.decimalsY);
    this.buffer.push({ ts: Date.now(), address, slot, active_id: pair.activeId, price });
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const ticks = this.buffer;
    this.buffer = [];
    try {
      await this.onTicks(ticks);
    } catch (err) {
      console.error(`[watcher] flush failed, dropped ${ticks.length} ticks`, err);
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    clearInterval(this.flushTimer);
    clearInterval(this.pollTimer);
    await this.flush();
    for (const [, pool] of this.watched) {
      if (pool.subscriptionId < 0) continue;
      await this.connection.removeAccountChangeListener(pool.subscriptionId).catch(() => undefined);
    }
    this.watched.clear();
  }
}
