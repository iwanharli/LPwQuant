/**
 * LP study, step 1: wallets that hold DLMM positions in a sample of screener pools (read from the engine API),
 * written to a JSON file for `python -m app.lp_study` (step 2). One getProgramAccounts per pool, fetching only
 * the 32-byte owner field.
 *
 *   npm run lp-owners -- --out /tmp/lp-owners.json [--pools 18] [--engine http://127.0.0.1:8000]
 */
import { writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { LBCLMM_PROGRAM_IDS, positionLbPairFilter } from "@meteora-ag/dlmm";
import { config } from "./config";
import { createFailoverFetch } from "./rpc";

const OWNER_OFFSET = 40; // PositionV2: 8-byte discriminator, lb_pair (32), owner (32)

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface EngineRow {
  address: string;
  name: string;
  tvl: number;
  volume_24h: number;
  fees_24h: number;
  bin_step: number;
  flags: string[];
}

async function main(): Promise<void> {
  const out = arg("out", "lp-owners.json");
  const count = Math.max(1, Number(arg("pools", "18")));
  const engine = arg("engine", "http://127.0.0.1:8000");
  if (config.rpcProviders.length === 0) throw new Error("no RPC provider configured");

  const res = await fetch(`${engine}/api/pools?limit=300`);
  if (!res.ok) throw new Error(`engine /api/pools: HTTP ${res.status}`);
  const rows = ((await res.json()) as { pools: EngineRow[] }).pools
    // Pools whose reported TVL fails the on-chain / Jupiter cross-check would distort the fee comparison.
    .filter((r) => r.tvl > 0 && r.fees_24h > 0 && !r.flags.includes("rugged") && !r.flags.includes("tvl_suspect"))
    .sort((a, b) => a.tvl - b.tvl);
  // Spread the sample across the TVL range, small pools to large.
  const picked =
    rows.length <= count ? rows : Array.from({ length: count }, (_, i) => rows[Math.round((i * (rows.length - 1)) / (count - 1))]);

  const conn = new Connection(config.rpcProviders[0].httpUrl, { fetch: createFailoverFetch(config.rpcProviders) });
  const program = new PublicKey(LBCLMM_PROGRAM_IDS["mainnet-beta"]);
  const owners: Record<string, string[]> = {};
  for (const pool of picked) {
    try {
      const accounts = await conn.getProgramAccounts(program, {
        filters: [positionLbPairFilter(new PublicKey(pool.address))],
        dataSlice: { offset: OWNER_OFFSET, length: 32 },
      });
      owners[pool.address] = [...new Set(accounts.map((a) => new PublicKey(a.account.data).toBase58()))];
      console.log(`${pool.name.slice(0, 18).padEnd(18)} positions ${accounts.length} owners ${owners[pool.address].length}`);
    } catch (err) {
      console.error(`${pool.name}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  writeFileSync(out, JSON.stringify({ created_at: Date.now(), pools: picked, owners }, null, 1));
  console.log(`wrote ${out}: ${Object.keys(owners).length} pools`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
