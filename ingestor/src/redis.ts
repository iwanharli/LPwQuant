import Redis from "ioredis";
import { config } from "./config";
import type { PoolSnapshot } from "./meteora";
import type { PriceTick } from "./watcher";

/** Keys shared with the engine. */
export const KEYS = {
  poolsLatest: "pools:latest", // hash: address -> PoolSnapshot JSON
  poolsStream: "stream:pools", // one entry per poll
  pricesStream: "stream:prices", // one entry per on-chain active-bin change
} as const;

export const redis = new Redis(config.redisUrl);

export async function publishPools(pools: PoolSnapshot[]): Promise<void> {
  const tmp = `${KEYS.poolsLatest}:tmp`;
  const multi = redis.multi();
  if (pools.length > 0) {
    multi.del(tmp);
    multi.hset(tmp, Object.fromEntries(pools.map((p) => [p.address, JSON.stringify(p)])));
    multi.rename(tmp, KEYS.poolsLatest);
  } else {
    multi.del(KEYS.poolsLatest);
  }
  multi.xadd(KEYS.poolsStream, "MAXLEN", "~", 1000, "*", "ts", String(Date.now()), "count", String(pools.length));
  await multi.exec();
}

export async function publishTicks(ticks: PriceTick[]): Promise<void> {
  const pipeline = redis.pipeline();
  for (const t of ticks) {
    pipeline.xadd(
      KEYS.pricesStream, "MAXLEN", "~", 100_000, "*",
      "ts", String(t.ts), "address", t.address, "slot", String(t.slot),
      "active_id", String(t.active_id), "price", String(t.price),
    );
  }
  await pipeline.exec();
}
