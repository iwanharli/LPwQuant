/**
 * One-off: bring stored history up to the current classification.
 *   npm run history-reclassify
 * Rows whose instruction names are stored are reclassified in place. Transfers and unrecognised rows are read again
 * from the chain, because telling a deposit, a withdrawal and a gacha payment apart needs the programs, the signer
 * and the counterparty, which older rows do not have.
 */
import { Connection } from "@solana/web3.js";
import { config } from "./config";
import { pg } from "./db";
import { createFailoverFetch } from "./rpc";
import { changes, classify, instructionNames, programsOf, refineTransfer } from "./wallet-history";
import { MAX_TX_VERSION } from "./tx-version";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const conn = new Connection(config.rpcProviders[0].httpUrl, { commitment: "confirmed", fetch: createFailoverFetch(config.rpcProviders) });
  const moved: Record<string, number> = {};
  const note = (from: string, to: string) => from !== to && (moved[`${from} -> ${to}`] = (moved[`${from} -> ${to}`] ?? 0) + 1);

  // 1. From stored instruction names: no chain reads.
  const named = await pg.query<{ signature: string; kind: string; instructions: string[] }>(
    `select signature, kind, instructions from portfolio_activity
     where source = 'chain' and instructions is not null and cardinality(instructions) > 0 and kind not in ('transfer', 'other')`,
  );
  for (const r of named.rows) {
    const kind = classify(r.instructions.map((n) => `Program log: Instruction: ${n}`));
    if (kind !== "other" && kind !== "transfer" && kind !== r.kind) {
      await pg.query("update portfolio_activity set kind = $2 where signature = $1", [r.signature, kind]);
      note(r.kind, kind);
    }
  }
  console.log("[reclassify] dari nama instruksi:", JSON.stringify(moved));

  // 2. Re-read from the chain what needs programs, signer and counterparty.
  const rows = (
    await pg.query<{ signature: string; wallet: string; kind: string; source: string }>(
      `select signature, wallet, kind, source from portfolio_activity
       where programs is null and kind in ('transfer', 'other') order by ts desc`,
    )
  ).rows;
  let done = 0;
  for (const r of rows) {
    let tx = null;
    for (let attempt = 0; attempt < 4 && !tx; attempt++) {
      try {
        tx = await conn.getParsedTransaction(r.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION });
        if (!tx) break;
      } catch {
        await sleep(1000 * 2 ** attempt);
      }
    }
    if (tx) {
      const logs = tx.meta?.logMessages ?? [];
      const ch = changes(tx, r.wallet);
      const kind = refineTransfer(classify(logs), ch);
      await pg.query(
        `update portfolio_activity set instructions = $2, programs = $3, signed = $4, counterparty = $5,
           kind = case when source = 'app' then kind else $6 end where signature = $1`,
        [r.signature, instructionNames(logs), programsOf(logs), ch.signed, ch.counterparty, kind],
      );
      if (r.source !== "app") note(r.kind, kind);
    }
    if (++done % 100 === 0) console.log(`[reclassify] ${done}/${rows.length}`);
    await sleep(150);
  }
  console.log("[reclassify] selesai", JSON.stringify(moved));
  await pg.end();
}

main().catch((err) => {
  console.error("[reclassify] gagal", err);
  process.exit(1);
});
