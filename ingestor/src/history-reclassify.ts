/**
 * One-off: re-read transactions stored before instruction names were kept, and classify them again.
 *   npm run history-reclassify
 */
import { Connection } from "@solana/web3.js";
import { config } from "./config";
import { pg } from "./db";
import { createFailoverFetch } from "./rpc";
import { classify, instructionNames } from "./wallet-history";

async function main(): Promise<void> {
  const conn = new Connection(config.rpcProviders[0].httpUrl, { commitment: "confirmed", fetch: createFailoverFetch(config.rpcProviders) });
  const { rows } = await pg.query<{ signature: string; kind: string; source: string }>(
    `select signature, kind, source from portfolio_activity
     where instructions is null and kind not in ('transfer', 'swap') order by ts desc`,
  );
  const moved: Record<string, number> = {};
  let done = 0;
  for (const r of rows) {
    let tx = null;
    for (let attempt = 0; attempt < 4 && !tx; attempt++) {
      try {
        tx = await conn.getParsedTransaction(r.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx) break;
      } catch {
        await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
      }
    }
    if (tx) {
      const logs = tx.meta?.logMessages ?? [];
      const kind = classify(logs);
      // An action the app logged keeps the kind the app gave it.
      await pg.query(
        `update portfolio_activity set instructions = $2,
           kind = case when source = 'app' then kind else $3 end where signature = $1`,
        [r.signature, instructionNames(logs), kind],
      );
      if (r.source !== "app" && kind !== r.kind) moved[`${r.kind} -> ${kind}`] = (moved[`${r.kind} -> ${kind}`] ?? 0) + 1;
    }
    if (++done % 100 === 0) console.log(`[reclassify] ${done}/${rows.length}`);
    await new Promise((res) => setTimeout(res, 150));
  }
  console.log("[reclassify] selesai", JSON.stringify(moved));
  await pg.end();
}

main().catch((err) => {
  console.error("[reclassify] gagal", err);
  process.exit(1);
});
