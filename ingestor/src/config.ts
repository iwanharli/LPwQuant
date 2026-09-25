import { config as loadEnv, parse as parseEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RpcProvider } from "./rpc";

loadEnv({ path: resolve(__dirname, "../../.env") });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number for ${name}: ${raw}`);
  return value;
}

const heliusKey = process.env.HELIUS_API_KEY ?? "";

/** GMGN_API_KEY from env, else from gmgn-cli's ~/.config/gmgn/.env. Only the API key is read: the
 * read-only endpoints we call do not need the private key stored next to it. */
function gmgnApiKey(): string {
  if (process.env.GMGN_API_KEY) return process.env.GMGN_API_KEY;
  const file = join(homedir(), ".config", "gmgn", ".env");
  return existsSync(file) ? (parseEnv(readFileSync(file)).GMGN_API_KEY ?? "") : "";
}

/** Primary (RPC_URL or Helius) first, then RPC_FALLBACKS="name=url,name=url" in order. */
function rpcProviders(): RpcProvider[] {
  const providers: RpcProvider[] = [];
  if (process.env.RPC_URL) providers.push({ name: "custom", httpUrl: process.env.RPC_URL });
  else if (heliusKey) providers.push({ name: "helius", httpUrl: `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` });

  for (const entry of (process.env.RPC_FALLBACKS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0 || !entry.slice(eq + 1).startsWith("http")) {
      throw new Error(`Invalid RPC_FALLBACKS entry "${entry.slice(0, Math.max(eq, 0)) || "?"}": expected name=https://...`);
    }
    providers.push({ name: entry.slice(0, eq), httpUrl: entry.slice(eq + 1) });
  }
  return providers;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/db_quant",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379/0",
  meteoraApi: process.env.METEORA_API_URL || "https://dlmm.datapi.meteora.ag",
  pollIntervalMs: num("POLL_INTERVAL_SEC", 60) * 1000,
  // A cycle that takes longer than this is treated as hung and abandoned, so the next one can start.
  pollTimeoutMs: num("POLL_TIMEOUT_SEC", 180) * 1000,
  fetchLimit: num("POOL_FETCH_LIMIT", 1000),
  poolLimit: num("POOL_LIMIT", 300),
  minTvl: num("MIN_TVL", 10_000),
  minVolume24h: num("MIN_VOLUME_24H", 50_000),
  watchTopN: num("WATCH_TOP_N", 25),
  // poll: getMultipleAccounts every WATCH_POLL_INTERVAL_SEC (cheap on credits); ws: accountSubscribe
  watchMode: (process.env.WATCH_MODE === "ws" ? "ws" : "poll") as "ws" | "poll",
  watchPollIntervalMs: Math.max(num("WATCH_POLL_INTERVAL_SEC", 10), 1) * 1000,
  retentionHours: num("RETENTION_HOURS", 168),
  // Bin liquidity around the active bin (fee share, uninitialized bin arrays): top N pools every N seconds.
  binsEnabled: process.env.BINS_ENABLED !== "false",
  binsTopN: num("BINS_TOP_N", 60),
  binsRefreshMs: Math.max(num("BINS_REFRESH_SEC", 300), 60) * 1000,
  binsArraysEachSide: Math.max(Math.round(num("BINS_ARRAYS_EACH_SIDE", 2)), 1),
  rpcProviders: rpcProviders(),
  // New-pool feed (new-pools.ts): how often to ask Meteora for its newest pools, and the TVL a new pool needs.
  newPoolPollMs: Math.max(num("NEW_POOL_POLL_SEC", 5), 5) * 1000,
  newPoolMinTvl: num("NEW_POOL_MIN_TVL", 500),
  // Builds unsigned claim-fee transactions for the dashboard (claim-server.ts); bound to 127.0.0.1.
  claimPort: num("CLAIM_PORT", 8010),
  engineUrl: process.env.ENGINE_URL || "http://127.0.0.1:8000",
  dashboardOrigins: (process.env.DASHBOARD_ORIGIN || "http://localhost:3000,http://127.0.0.1:3000").split(","),
  wsUrl: process.env.WS_URL || (heliusKey ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}` : ""),
  wsProviderName: process.env.WS_URL ? "custom" : "helius",
  gmgnEnabled: process.env.GMGN_ENABLED !== "false",
  gmgnApiKey: gmgnApiKey(),
  gmgnInfoRefreshMs: num("GMGN_INFO_REFRESH_MIN", 60) * 60_000,
  gmgnHoldersRefreshMs: num("GMGN_HOLDERS_REFRESH_MIN", 120) * 60_000,
  gmgnHoldersTopN: num("GMGN_HOLDERS_TOP_N", 100),
  schemaPath: resolve(__dirname, "../../db/schema.sql"),
};
