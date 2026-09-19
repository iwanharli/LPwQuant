/**
 * One-off: read a wallet's whole transaction history into portfolio_activity. Resumable, safe to rerun.
 *   npm run history-backfill -- <wallet>        (no wallet: every wallet on the portfolio page)
 */
import { pg } from "./db";
import { WalletHistory } from "./wallet-history";

async function main(): Promise<void> {
  const history = new WalletHistory();
  const arg = process.argv[2];
  const wallets = arg ? [arg] : (await pg.query<{ address: string }>("select address from portfolio_wallets")).rows.map((r) => r.address);
  for (const wallet of wallets) {
    const n = await history.backfill(wallet, (done, oldest) =>
      console.log(`[backfill] ${wallet.slice(0, 4)}…: ${done} transaksi, sampai ${oldest ? new Date(oldest * 1000).toISOString().slice(0, 16) : "?"}`),
    );
    console.log(`[backfill] ${wallet.slice(0, 4)}… selesai: ${n} transaksi lama ditambahkan`);
  }
  await pg.end();
}

main().catch((err) => {
  console.error("[backfill] gagal", err);
  process.exit(1);
});
