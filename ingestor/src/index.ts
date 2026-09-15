import { config } from "./config";
import { applySchema, pg, pruneOld, savePools, saveTicks, saveUsage } from "./db";
import { fetchPool, fetchPools, type PoolSnapshot } from "./meteora";
import { publishPools, publishTicks, redis } from "./redis";
import { BinDepthFetcher } from "./bins";
import { JupiterFetcher } from "./jupiter";
import { PumpFetcher } from "./pump";
import { usage } from "./rpc";
import { GmgnFetcher } from "./gmgn";
import { CandleFetcher, FlowFetcher } from "./market";
import { SecurityFetcher } from "./security";
import { PoolWatcher, type PriceTick } from "./watcher";

// Log timestamps in GMT+7 (WIB).
const wib = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "medium" });
for (const level of ["log", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => original(`${wib.format(new Date())} WIB`, ...args);
}

/** Pools the engine's paper trader holds positions in (engine/app/service.py keeps this set current). */
const PAPER_OPEN_POOLS_KEY = "paper:open_pools";

/** Keep tracking pools with open paper positions even after they drop out of the top-volume screen, so a
 * position is closed by its own exit rules rather than because the screener stopped watching the pool. */
async function withPinnedPools(pools: PoolSnapshot[], pinned: string[]): Promise<PoolSnapshot[]> {
  const tracked = new Set(pools.map((p) => p.address));
  const extra: PoolSnapshot[] = [];
  for (const address of pinned) {
    if (tracked.has(address)) continue;
    try {
      const pool = await fetchPool(address);
      if (pool) extra.push(pool);
    } catch (err) {
      console.error(`[poller] pinned pool ${address}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return extra.length > 0 ? [...pools, ...extra] : pools;
}

async function onTicks(ticks: PriceTick[]): Promise<void> {
  await Promise.all([saveTicks(ticks), publishTicks(ticks)]);
}

async function main(): Promise<void> {
  await applySchema();
  const security = new SecurityFetcher();
  await security.load();
  const organic = new JupiterFetcher();
  await organic.load();
  const pump = new PumpFetcher();
  await pump.load();
  const candles = new CandleFetcher();
  await candles.load();
  const flow = new FlowFetcher();
  const gmgn = config.gmgnEnabled && config.gmgnApiKey ? new GmgnFetcher() : null;
  if (gmgn) await gmgn.load();
  else console.warn("[ingestor] GMGN disabled (no API key in env or ~/.config/gmgn/.env)");

  const canWatch = config.rpcProviders.length > 0 && (config.watchMode === "poll" || config.wsUrl);
  const watcher = canWatch ? new PoolWatcher(onTicks) : null;
  const bins = config.binsEnabled && config.rpcProviders.length > 0 ? new BinDepthFetcher() : null;
  if (!watcher) console.warn("[ingestor] RPC not configured: on-chain watcher disabled, API polling only");
  else {
    const names = config.rpcProviders.map((p) => p.name).join(" → ");
    const mode =
      config.watchMode === "ws"
        ? `ws (${config.wsProviderName})`
        : `poll every ${config.watchPollIntervalMs / 1000}s`;
    console.log(`[ingestor] rpc http: ${names}; watch mode: ${mode}`);
  }

  let usageSince = Date.now();
  const flushUsage = async (): Promise<string> => {
    const rows = usage.drain();
    try {
      await saveUsage(rows, usageSince);
      usageSince = Date.now();
    } catch (err) {
      for (const r of rows) usage.record(r.provider, r.kind, r.method, r.count); // retry next poll
      throw err;
    }
    const sum = (kind: string) => rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.count, 0);
    return `rpc ${sum("http")} calls/${sum("http_error")} errors, ws ${sum("ws_message")} msgs`;
  };

  let lastPrune = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const poll = async () => {
    const started = Date.now();
    try {
      const pinned = await redis.smembers(PAPER_OPEN_POOLS_KEY);
      const pools = await withPinnedPools(await fetchPools(), pinned);
      await savePools(pools);
      await publishPools(pools);
      security.enqueue(pools);
      organic.enqueue(pools);
      pump.enqueue(pools);
      candles.enqueue(pools);
      flow.maybeRefresh(pools);
      gmgn?.maybeRefresh(pools);
      bins?.maybeRefresh(pools, pinned);
      await watcher?.sync(pools);
      if (started - lastPrune > 3_600_000) {
        await pruneOld();
        lastPrune = started;
      }
      const usageSummary = await flushUsage();
      console.log(
        `[poller] ${pools.length} pools, watching ${watcher?.size ?? 0}, security ${security.known} known/${security.pending} queued, organic ${organic.known}, pump ${pump.known}, candles ${candles.tracked} pools/${candles.pending} queued, flow ${flow.lastCount}, gmgn ${gmgn?.known ?? "off"}, bins ${bins?.lastCount ?? "off"}, ${usageSummary}, ${Date.now() - started}ms`,
      );
    } catch (err) {
      console.error("[poller] failed", err);
    }
    if (!stopped) timer = setTimeout(poll, config.pollIntervalMs);
  };

  const shutdown = async () => {
    stopped = true;
    clearTimeout(timer);
    security.stop();
    organic.stop();
    pump.stop();
    candles.stop();
    gmgn?.stop();
    await watcher?.close();
    await flushUsage().catch((err) => console.error("[usage] final flush failed", err));
    await Promise.allSettled([pg.end(), redis.quit()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await poll();
}

main().catch((err) => {
  console.error("[ingestor] fatal", err);
  process.exit(1);
});
