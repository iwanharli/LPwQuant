/**
 * One-off: fill network fees and Meteora pool fees for transactions stored before costs were recorded.
 *   npm run history-costs
 */
import { Connection } from "@solana/web3.js";
import { config } from "./config";
import { pg } from "./db";
import { createFailoverFetch } from "./rpc";
import { costsOf } from "./tx-costs";
import { MAX_TX_VERSION } from "./tx-version";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const conn = new Connection(config.rpcProviders[0].httpUrl, { commitment: "confirmed", fetch: createFailoverFetch(config.rpcProviders) });
  const { rows } = await pg.query<{ signature: string }>(
    "select signature from portfolio_activity where network_fee_lamports is null and sol_delta is not null order by ts desc",
  );
  let done = 0;
  for (const { signature } of rows) {
    let tx = null;
    for (let attempt = 0; attempt < 4 && !tx; attempt++) {
      try {
        tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: MAX_TX_VERSION });
        if (!tx) break;
      } catch {
        await sleep(1000 * 2 ** attempt);
      }
    }
    if (tx) {
      const c = await costsOf(tx);
      await pg.query(
        "update portfolio_activity set network_fee_lamports = $2, pool_fees = $3::jsonb, other_dex_swap = $4 where signature = $1",
        [signature, c.networkFeeLamports, JSON.stringify(c.poolFees), c.otherDexSwap],
      );
    }
    if (++done % 200 === 0) console.log(`[costs] ${done}/${rows.length}`);
    await sleep(150);
  }
  console.log(`[costs] selesai ${done}`);
  await pg.end();
}

main().catch((err) => {
  console.error("[costs] gagal", err);
  process.exit(1);
});
