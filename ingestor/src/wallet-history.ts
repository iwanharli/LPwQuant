/**
 * Transaction history of the wallets on the portfolio page, read from the chain into portfolio_activity.
 *
 * Covers what the app sent (claims, limit orders) and what the user did elsewhere (Meteora, Jupiter), so the
 * history tab is complete. Each transaction is classified from its program logs and stored with the wallet's own
 * token and SOL changes, which the chain records exactly. Read-only.
 */
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { config } from "./config";
import { pg } from "./db";
import { apiFetch, createFailoverFetch } from "./rpc";
import { costsOf, type TxCosts } from "./tx-costs";
import { MAX_TX_VERSION } from "./tx-version";

const EVERY_MS = 5 * 60_000;
const FIRST_SYNC_LIMIT = 150; // how far back a newly watched wallet is read
const PAGE = 50;
const GAP_MS = 150; // between transaction reads: batch requests are refused on this RPC plan, and bursts hit 429
const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const PLUMBING = new Set([
  "11111111111111111111111111111111", // System
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo v2
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

type Delta = { mint: string; symbol: string; amount: number };

const symbols = new Map<string, string>([[SOL_MINT, "SOL"]]);

async function nameMints(mints: string[]): Promise<void> {
  const unknown = [...new Set(mints)].filter((m) => !symbols.has(m));
  for (let i = 0; i < unknown.length; i += 100) {
    const chunk = unknown.slice(i, i + 100);
    try {
      const res = await apiFetch("jupiter", "assets/search", `${JUP_SEARCH}?query=${chunk.join(",")}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      for (const a of (await res.json()) as { id: string; symbol?: string }[]) if (a.symbol) symbols.set(a.id, a.symbol);
    } catch {
      // unnamed mints show as a short address; the next sync tries again
    }
  }
}

export function instructionNames(logs: string[]): string[] {
  return [...new Set(logs.map((l) => /Instruction: (\w+)/.exec(l)?.[1]).filter((n): n is string => !!n))];
}

export function programsOf(logs: string[]): string[] {
  return [...new Set(logs.map((l) => /^Program (\w{32,44}) invoke/.exec(l)?.[1]).filter((p): p is string => !!p))];
}

// Metaplex Core: the NFT standard gacha/pack sites mint their cards with.
const METAPLEX_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

/**
 * What a transaction did, from the instruction names and programs in its logs. Order matters: closing a position
 * also claims its fees, and withdrawing a filled limit order claims too, so the bigger action is checked before the
 * claim that rides along. Transfers are refined later (deposit / withdraw / gacha refund) with the direction and
 * the counterparty, which the logs do not carry.
 */
export function classify(logs: string[]): string {
  const names = instructionNames(logs);
  const programs = programsOf(logs);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (programs.includes(METAPLEX_CORE)) return "gacha";
  if (has(/^RemoveLiquidity|^ClosePosition|^RemoveAllLiquidity/)) return "remove_liquidity";
  if (has(/^CancelLimitOrder|^CloseLimitOrder/)) return "limit_order_cancel";
  if (has(/^PlaceLimitOrder/)) return "limit_order_place";
  if (has(/^AddLiquidity|^InitializePosition|^ZapIn/)) return "add_liquidity";
  if (has(/^RebalanceLiquidity/)) return "rebalance";
  if (has(/^ClaimFee/)) return "claim";
  if (has(/^Swap|Route|^ExactOut|^Fill$|^Buy$|^Sell$/)) return "swap";
  if (programs.length > 0 && programs.every((p) => PLUMBING.has(p))) return "transfer";
  return "other";
}

type Changes = { sol: number; deltas: Omit<Delta, "symbol">[]; signed: boolean; counterparty: string | null };

export function changes(tx: ParsedTransactionWithMeta, owner: string): Changes {
  const meta = tx.meta;
  const signed = tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey.toBase58() === owner);
  if (!meta) return { sol: 0, deltas: [], signed, counterparty: null };
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === owner);
  const sol = i >= 0 ? (meta.postBalances[i] - meta.preBalances[i]) / 1e9 : 0;
  const amount = (b: { uiTokenAmount: { uiAmountString?: string } }) => Number(b.uiTokenAmount.uiAmountString ?? 0);
  const byMint = new Map<string, number>();
  for (const b of meta.preTokenBalances ?? []) if (b.owner === owner) byMint.set(b.mint, (byMint.get(b.mint) ?? 0) - amount(b));
  for (const b of meta.postTokenBalances ?? []) if (b.owner === owner) byMint.set(b.mint, (byMint.get(b.mint) ?? 0) + amount(b));
  const deltas = [...byMint.entries()].filter(([, d]) => Math.abs(d) > 1e-12).map(([mint, d]) => ({ mint, amount: d }));
  // The other side of the biggest token move: whose balance of that mint moved the opposite way.
  let counterparty: string | null = null;
  const main = [...deltas].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
  if (main) {
    const other = new Map<string, number>();
    for (const b of meta.preTokenBalances ?? []) if (b.mint === main.mint && b.owner && b.owner !== owner) other.set(b.owner, (other.get(b.owner) ?? 0) - amount(b));
    for (const b of meta.postTokenBalances ?? []) if (b.mint === main.mint && b.owner && b.owner !== owner) other.set(b.owner, (other.get(b.owner) ?? 0) + amount(b));
    counterparty = [...other.entries()].filter(([, d]) => Math.sign(d) === -Math.sign(main.amount)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] ?? null;
  }
  return { sol, deltas, signed, counterparty };
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** A plain transfer is a deposit when money arrives without the wallet signing (a top-up, an exchange withdrawal),
 * and a withdrawal when the wallet sends SOL or USDC away. Tiny amounts stay "transfer": dust and spam. Gacha refunds
 * are told apart later, by timing, in the engine. */
export function refineTransfer(kind: string, ch: Changes): string {
  if (kind !== "transfer") return kind;
  const usdc = ch.deltas.find((d) => d.mint === USDC_MINT)?.amount ?? 0;
  const value = usdc + ch.sol * 100; // rough USD, only to separate real money from dust
  if (value >= 1 && !ch.signed) return "deposit";
  if (value <= -1 && ch.signed) return "withdraw";
  return "transfer";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(job: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await job();
    } catch (err) {
      const limited = err instanceof Error && /429|too many requests/i.test(err.message + String((err as { code?: number }).code));
      if (!limited || attempt >= tries) throw err;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

export class WalletHistory {
  private readonly connection = new Connection(config.rpcProviders[0].httpUrl, {
    commitment: "confirmed",
    fetch: createFailoverFetch(config.rpcProviders),
  });
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    const tick = () => void this.syncAll().catch((err) => console.warn("[history] sync failed", err instanceof Error ? err.message : err));
    tick();
    this.timer = setInterval(tick, EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async syncAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { rows } = await pg.query<{ address: string }>("select address from portfolio_wallets");
      for (const { address } of rows) {
        await this.sync(address);
        await this.syncTokenAccounts(address);
      }
    } finally {
      this.running = false;
    }
  }

  /** New transactions since the newest one already read from the chain (sol_delta is only set by this sync). */
  async sync(owner: string): Promise<number> {
    const { rows } = await pg.query<{ signature: string }>(
      "select signature from portfolio_activity where wallet = $1 and sol_delta is not null order by ts desc limit 1",
      [owner],
    );
    const until = rows[0]?.signature;
    const key = new PublicKey(owner);
    const sigs: { signature: string; blockTime?: number | null; err: unknown }[] = [];
    let before: string | undefined;
    const cap = until ? 1000 : FIRST_SYNC_LIMIT;
    while (sigs.length < cap) {
      const page = await withRetry(() => this.connection.getSignaturesForAddress(key, { limit: PAGE, before, until }));
      sigs.push(...page);
      if (page.length < PAGE) break;
      before = page[page.length - 1].signature;
    }
    if (sigs.length === 0) return 0;
    return this.store(owner, sigs);
  }

  /**
   * Transactions that touch the wallet's USDC account but not the wallet address: a top-up or an exchange
   * withdrawal sends USDC to the token account, and the wallet's own signature list never shows it. The first run
   * reads the account's whole history; later runs only what is new. Signatures already stored are skipped.
   */
  async syncTokenAccounts(owner: string): Promise<number> {
    const account = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(owner), true).toBase58();
    const { rows } = await pg.query<{ signature: string }>(
      "select signature from portfolio_sync_cursor where wallet = $1 and account = $2",
      [owner, account],
    );
    const until = rows[0]?.signature;
    const key = new PublicKey(account);
    const sigs: { signature: string; blockTime?: number | null; err: unknown }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await withRetry(() => this.connection.getSignaturesForAddress(key, { limit: 1000, before, until }));
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    if (sigs.length === 0) return 0;
    const known = new Set(
      (await pg.query<{ signature: string }>("select signature from portfolio_activity where signature = any($1)", [sigs.map((s) => s.signature)])).rows.map((r) => r.signature),
    );
    const missing = sigs.filter((s) => !known.has(s.signature));
    const stored = missing.length ? await this.store(owner, missing) : 0;
    await pg.query(
      `insert into portfolio_sync_cursor (wallet, account, signature) values ($1, $2, $3)
       on conflict (wallet, account) do update set signature = excluded.signature`,
      [owner, account, sigs[0].signature],
    );
    if (stored) console.log(`[history] ${owner.slice(0, 4)}… akun USDC: ${stored} transaksi baru`);
    return stored;
  }

  /**
   * Everything older than the oldest transaction already stored, back to the wallet's first. Resumable: a rerun
   * starts from wherever the last one stopped. Stores as it goes, so an interruption loses at most one batch.
   */
  async backfill(owner: string, onProgress?: (done: number, oldest: number | null) => void): Promise<number> {
    const key = new PublicKey(owner);
    let total = 0;
    for (;;) {
      const { rows } = await pg.query<{ signature: string }>(
        "select signature from portfolio_activity where wallet = $1 and sol_delta is not null order by ts asc limit 1",
        [owner],
      );
      const before = rows[0]?.signature;
      const page = await withRetry(() => this.connection.getSignaturesForAddress(key, { limit: PAGE, before }));
      if (page.length === 0) return total;
      total += await this.store(owner, page);
      onProgress?.(total, page[page.length - 1].blockTime ?? null);
      if (page.length < PAGE) return total;
    }
  }

  private async store(owner: string, sigs: { signature: string; blockTime?: number | null; err: unknown }[]): Promise<number> {
    const records: { sig: string; ts: number; ok: boolean; kind: string; ix: string[]; progs: string[]; ch: Changes; cost: TxCosts }[] = [];
    for (const s of sigs) {
      const tx = await withRetry(() =>
        this.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION }),
      );
      await sleep(GAP_MS);
      if (!tx) continue;
      const logs = tx.meta?.logMessages ?? [];
      const ch = changes(tx, owner);
      records.push({
        sig: s.signature,
        ts: (s.blockTime ?? tx.blockTime ?? Date.now() / 1000) * 1000,
        ok: !s.err,
        kind: refineTransfer(classify(logs), ch),
        ix: instructionNames(logs),
        progs: programsOf(logs),
        ch,
        cost: await costsOf(tx),
      });
    }
    await nameMints(records.flatMap((r) => r.ch.deltas.map((d) => d.mint)));
    for (const r of records) {
      const deltas: Delta[] = r.ch.deltas.map((d) => ({ ...d, symbol: symbols.get(d.mint) ?? `${d.mint.slice(0, 4)}…` }));
      await pg.query(
        `insert into portfolio_activity
           (signature, wallet, ts, kind, source, ok, sol_delta, deltas, instructions, programs, signed, counterparty,
            network_fee_lamports, pool_fees, other_dex_swap)
         values ($1, $2, to_timestamp($3 / 1000.0), $4, 'chain', $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14)
         on conflict (signature) do update set
           ts = excluded.ts, ok = excluded.ok, sol_delta = excluded.sol_delta, deltas = excluded.deltas,
           instructions = excluded.instructions, programs = excluded.programs, signed = excluded.signed,
           counterparty = excluded.counterparty, network_fee_lamports = excluded.network_fee_lamports,
           pool_fees = excluded.pool_fees, other_dex_swap = excluded.other_dex_swap,
           kind = case when portfolio_activity.source = 'app' then portfolio_activity.kind else excluded.kind end`,
        [r.sig, owner, r.ts, r.kind, r.ok, r.ch.sol, JSON.stringify(deltas), r.ix, r.progs, r.ch.signed, r.ch.counterparty,
         r.cost.networkFeeLamports, JSON.stringify(r.cost.poolFees), r.cost.otherDexSwap],
      );
    }
    console.log(`[history] ${owner.slice(0, 4)}…: ${records.length} transaksi baru`);
    return records.length;
  }
}
