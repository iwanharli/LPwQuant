import { config } from "./config";
import { applySchema, pg, pruneOld, savePools, saveTicks, saveUsage } from "./db";
import { fetchPool, fetchPools, type PoolSnapshot } from "./meteora";
import { publishPools, publishTicks, redis } from "./redis";
import { BinDepthFetcher } from "./bins";
import { JupiterFetcher } from "./jupiter";
import { PumpFetcher } from "./pump";
import { usage } from "./rpc";
import { startAutoClose } from "./auto-close";
import { startClaimServer } from "./claim-server";
import { WalletHistory } from "./wallet-history";
import { NewPoolFeed } from "./new-pools";
import { OnchainPoolFeed } from "./onchain-pools";
import { GmgnFetcher } from "./gmgn";
import { CandleFetcher, FlowFetcher, withTimeout } from "./market";
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
/** Pools someone has open on the dashboard's pool page (engine/app/main.py watch_pool): address -> until, ms. */
const VIEWED_POOLS_KEY = "viewed:pools";

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
  const claimServer = config.rpcProviders.length > 0 ? startClaimServer() : null;
  const autoClose = claimServer ? startAutoClose() : null;
  const history = config.rpcProviders.length > 0 ? new WalletHistory() : null;
  history?.start();
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

  // A new pool found by the feed triggers the next cycle now rather than up to a minute later.
  let polling = false;
  const newPools = new NewPoolFeed((added) => {
    security.enqueueFirst(added);
    pollNow();
  });

  // Asked for while a cycle is running: run again as soon as it ends instead of waiting the full interval.
  let rerun = false;
  const pollNow = () => {
    if (stopped) return;
    if (polling) {
      rerun = true;
      return;
    }
    if (timer) clearTimeout(timer);
    void poll();
  };
  // A new pool's alert waits on its safety check: once that lands, publish at once rather than on the next cycle.
  security.onPriorityDone = pollNow;

  let solUsd = 0;
  let lastOnchainMessages = 0;
  const onchain = config.onchainNewPools ? new OnchainPoolFeed((p) => newPools.addOnchain(p), () => solUsd || 150) : null;

  const poll = async () => {
    if (polling) return;
    polling = true;
    rerun = false;
    const started = Date.now();
    try {
      await withTimeout(pollOnce(started), config.pollTimeoutMs, "poll");
    } catch (err) {
      console.error("[poller] failed", err);
    }
    polling = false;
    if (!stopped) timer = setTimeout(poll, rerun ? 0 : config.pollIntervalMs);
  };

  // One cycle. Everything it awaits has its own timeout, but a socket that never answers still hangs the whole
  // loop, and the process then looks alive while collecting nothing -- which is exactly what happened on
  // 2026-09-25. The caller therefore bounds the cycle as a whole.
  const pollOnce = async (started: number) => {
      const viewed = await redis.zrangebyscore(VIEWED_POOLS_KEY, Date.now(), "+inf");
      const pinned = [...new Set([...(await redis.smembers(PAPER_OPEN_POOLS_KEY)), ...viewed])];
      const listed = await fetchPools();
      // Heartbeat for the watchdog: the DLMM log subscription is alive only while its message count keeps rising.
      if (onchain && onchain.messages > lastOnchainMessages) {
        lastOnchainMessages = onchain.messages;
        await redis.set("onchain:alive", String(onchain.messages), "EX", 600);
      }
      solUsd = listed.find((p) => p.token_y.symbol === "SOL" && p.token_y.price_usd)?.token_y.price_usd ?? solUsd;
      const known = new Set(listed.map((p) => p.address));
      const fresh = newPools.current().filter((p) => !known.has(p.address));
      const pools = await withPinnedPools([...listed, ...fresh], pinned);
      await savePools(pools);
      await publishPools(pools);
      security.enqueue(pools);
      organic.enqueue(pools);
      pump.enqueue(pools);
      candles.enqueue(pools);
      flow.maybeRefresh(pools);
      gmgn?.maybeRefresh(pools);
      bins?.maybeRefresh(pools, pinned);
      await watcher?.sync(pools, viewed);
      if (started - lastPrune > 3_600_000) {
        await pruneOld();
        lastPrune = started;
      }
      const usageSummary = await flushUsage();
      console.log(
        `[poller] ${pools.length} pools (${fresh.length} baru), watching ${watcher?.size ?? 0}, security ${security.known} known/${security.pending} queued, organic ${organic.known}, pump ${pump.known}, candles ${candles.tracked} pools/${candles.pending} queued, flow ${flow.lastCount}, gmgn ${gmgn?.known ?? "off"}, bins ${bins?.lastCount ?? "off"}, onchain ${onchain ? `${onchain.created} dibuat/${onchain.messages} log` : "off"}, ${usageSummary}, ${Date.now() - started}ms`,
      );
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
    claimServer?.close();
    if (autoClose) clearInterval(autoClose);
    history?.stop();
    newPools.stop();
    onchain?.stop();
    await flushUsage().catch((err) => console.error("[usage] final flush failed", err));
    await Promise.allSettled([pg.end(), redis.quit()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  newPools.start();
  onchain?.start();
  await poll();
}

main().catch((err) => {
  console.error("[ingestor] fatal", err);
  process.exit(1);
});
