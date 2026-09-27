/**
 * "Bersihkan debu": empty and close the wallet's token accounts to get their rent (~0.002 SOL each) back.
 *
 * Per account: burn what is left (never for wrapped SOL, whose close returns the balance itself), sweep any
 * Token-2022 transfer fee withheld in it to the mint (permissionless, and a close fails while any is withheld),
 * then close it with the rent going to the owner. Like every builder here it never signs: it returns unsigned
 * transactions with the owner as fee payer, simulated first, for the user's wallet to approve.
 */
import {
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createHarvestWithheldTokensToMintInstruction,
  getExtensionData,
  unpackAccount,
} from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PER_TX = 6; // burn + close (+ harvest) per account: six accounts keep a transaction well under the size limit
const CU_PRICE = 50_000;
// Never burned: the user's core balances. They can still be closed once their balance is 0.
const PROTECTED = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", // jlUSDC
]);

export type DustAccount = {
  account: string;
  mint: string;
  program: "token" | "token-2022";
  amount: number;
  raw: string;
  decimals: number;
  rent_sol: number;
  frozen: boolean;
  withheld: boolean;
  wrapped_sol: boolean;
  protected: boolean;
};

type Parsed = DustAccount & { owner: string };

async function accountsOf(conn: Connection, owner: PublicKey): Promise<Parsed[]> {
  const out: Parsed[] = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM_ID]) {
    const res = await conn.getTokenAccountsByOwner(owner, { programId });
    const mints = new Map<string, number>();
    const decoded = res.value.map((a) => ({ pubkey: a.pubkey, lamports: a.account.lamports, acc: unpackAccount(a.pubkey, a.account, programId) }));
    // Decimals for burnChecked come from each mint, read in one batch.
    const mintKeys = [...new Set(decoded.map((d) => d.acc.mint.toBase58()))];
    for (let i = 0; i < mintKeys.length; i += 100) {
      const chunk = mintKeys.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(chunk.map((m) => new PublicKey(m)));
      infos.forEach((info, j) => mints.set(chunk[j], info ? info.data[44] : 0)); // Mint layout: decimals at byte 44
    }
    for (const { pubkey, lamports, acc } of decoded) {
      const mint = acc.mint.toBase58();
      const decimals = mints.get(mint) ?? 0;
      let withheld = false;
      if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
        const fee = getExtensionData(ExtensionType.TransferFeeAmount, acc.tlvData);
        withheld = !!fee && fee.readBigUInt64LE(0) > 0n;
      }
      out.push({
        account: pubkey.toBase58(),
        owner: acc.owner.toBase58(),
        mint,
        program: programId.equals(TOKEN_PROGRAM) ? "token" : "token-2022",
        amount: Number(acc.amount) / 10 ** decimals,
        raw: acc.amount.toString(),
        decimals,
        rent_sol: lamports / 1e9 - (acc.isNative ? Number(acc.amount) / 1e9 : 0),
        frozen: acc.isFrozen,
        withheld,
        wrapped_sol: acc.mint.equals(NATIVE_MINT),
        protected: PROTECTED.has(mint) && acc.amount > 0n,
      });
    }
  }
  return out;
}

export async function listDust(conn: Connection, owner: string): Promise<DustAccount[]> {
  return (await accountsOf(conn, new PublicKey(owner))).map(({ owner: _o, ...a }) => a);
}

export async function buildDustClose(conn: Connection, ownerStr: string, accounts: string[]) {
  const owner = new PublicKey(ownerStr);
  const all = new Map((await accountsOf(conn, owner)).map((a) => [a.account, a]));
  const chosen: Parsed[] = [];
  const skipped: { account: string; reason: string }[] = [];
  for (const addr of new Set(accounts)) {
    const a = all.get(addr);
    if (!a) skipped.push({ account: addr, reason: "bukan akun token milik wallet ini" });
    else if (a.frozen) skipped.push({ account: addr, reason: "dibekukan pembuat token, tidak bisa ditutup" });
    else if (a.protected) skipped.push({ account: addr, reason: "stablecoin dengan saldo: tidak dibakar" });
    else chosen.push(a);
  }
  if (!chosen.length) throw new Error(skipped[0]?.reason ?? "tidak ada akun yang dipilih");

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const transactions: string[] = [];
  let rent = 0;
  for (let i = 0; i < chosen.length; i += PER_TX) {
    const ixs: TransactionInstruction[] = [];
    for (const a of chosen.slice(i, i + PER_TX)) {
      const program = a.program === "token" ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM_ID;
      const acc = new PublicKey(a.account);
      const mint = new PublicKey(a.mint);
      if (BigInt(a.raw) > 0n && !a.wrapped_sol) {
        ixs.push(createBurnCheckedInstruction(acc, mint, owner, BigInt(a.raw), a.decimals, [], program));
      }
      if (a.withheld) ixs.push(createHarvestWithheldTokensToMintInstruction(mint, [acc], TOKEN_2022_PROGRAM_ID));
      ixs.push(createCloseAccountInstruction(acc, owner, owner, [], program));
      rent += a.rent_sol;
    }
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 * PER_TX }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }), ...ixs);
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) throw new Error(`simulasi gagal: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
    transactions.push(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
  }
  const fee = transactions.length * (5000 + Math.ceil((30_000 * PER_TX * CU_PRICE) / 1e6)) / 1e9;
  return { transactions, closing: chosen.length, reclaim_sol: rent, network_fee_sol: fee, skipped };
}
