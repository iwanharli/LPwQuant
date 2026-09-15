/**
 * Backfill 30m candles, walking back in 48h windows.
 *
 * Universes:
 *   top     (default) the current top pools by 24h volume
 *   recent  every pool created in the last --days with cumulative volume >= --min-cum-volume, found by scanning
 *           the full pool list. Includes pools that have since died or rugged, which removes most of the
 *           survivorship bias of "top". Older pools that died inside the window are still missed.
 *
 * Usage:
 *   npm run backfill -- --days 7 --top 50
 *   npm run backfill -- --universe recent --days 7 --min-cum-volume 250000
 */
import { applySchema, pg, savePools } from "./db";
import { CANDLE_WINDOW_MS, RateLimitedError, fetchCandles, saveCandles, sleep } from "./market";
import { fetchPoolPage, type PoolSnapshot } from "./meteora";
import { KEYS, redis } from "./redis";

const REQUEST_GAP_MS = 2_000;
const PAGE_GAP_MS = 1_000;

function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}

function strArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function topUniverse(top: number): Promise<PoolSnapshot[]> {
  const pools = (await redis.hvals(KEYS.poolsLatest))
    .map((v) => JSON.parse(v) as PoolSnapshot)
    .sort((a, b) => b.volume["24h"] - a.volume["24h"])
    .slice(0, top);
  if (pools.length === 0) throw new Error("no pools in redis: run the ingestor first");
  return pools;
}

async function recentUniverse(days: number, minCumVolume: number): Promise<PoolSnapshot[]> {
  const createdAfter = Date.now() - days * 24 * 3_600_000;
  // Keyed by address: the list is sorted by live volume, so pools can shift between pages mid-scan.
  const found = new Map<string, PoolSnapshot>();
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const result = await fetchPoolPage(page);
    pages = result.pages;
    for (const { snapshot, cumulativeVolume, blacklisted } of result.pools) {
      const created = snapshot.pool_created_at ?? 0;
      if (!blacklisted && created >= createdAfter && cumulativeVolume >= minCumVolume) found.set(snapshot.address, snapshot);
    }
    if (page % 10 === 0 || page === pages) console.log(`scanned page ${page}/${pages}, ${found.size} pools selected`);
    await sleep(PAGE_GAP_MS);
  }
  const selected = [...found.values()];
  // Register them so the backtest knows bin step / base fee, with today's (possibly near-zero) TVL.
  for (let i = 0; i < selected.length; i += 500) await savePools(selected.slice(i, i + 500));
  const alive = selected.filter((p) => p.volume["24h"] >= 50_000).length;
  console.log(`recent universe: ${selected.length} pools (${alive} still active, ${selected.length - alive} faded/dead)`);
  return selected;
}

async function main(): Promise<void> {
  const days = numArg("days", 7);
  const universe = strArg("universe", "top");
  await applySchema();

  const pools =
    universe === "recent"
      ? await recentUniverse(days, numArg("min-cum-volume", 250_000))
      : universe === "top"
        ? await topUniverse(numArg("top", 50))
        : (() => {
            throw new Error(`unknown --universe ${universe} (expected top or recent)`);
          })();

  const now = Date.now();
  const oldest = now - days * 24 * 3_600_000;
  let total = 0;

  for (const [index, pool] of pools.entries()) {
    let count = 0;
    const floor = Math.max(oldest, (pool.pool_created_at ?? oldest) - CANDLE_WINDOW_MS);
    for (let end = now; end > floor; ) {
      const start = Math.max(end - CANDLE_WINDOW_MS, floor);
      try {
        const candles = await fetchCandles(pool.address, start, end);
        await saveCandles(pool.address, candles);
        count += candles.length;
        if (candles.length === 0) break; // pool did not exist yet
        end = start;
      } catch (err) {
        if (err instanceof RateLimitedError) {
          console.warn("rate limited, waiting 60s");
          await sleep(60_000);
          continue;
        }
        console.error(`${pool.name}: ${err instanceof Error ? err.message : err}`);
        break;
      }
      await sleep(REQUEST_GAP_MS);
    }
    total += count;
    console.log(`[${index + 1}/${pools.length}] ${pool.name}: ${count} candles`);
  }
  console.log(`done: ${total} candles for ${pools.length} pools over ${days} days`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => Promise.allSettled([pg.end(), redis.quit()]));
