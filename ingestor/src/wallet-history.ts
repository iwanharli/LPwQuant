/**
 * Transaction history of the wallets on the portfolio page, read from the chain into portfolio_activity.
 *
 * Covers what the app sent (claims, limit orders) and what the user did elsewhere (Meteora, Jupiter), so the
 * history tab is complete. Each transaction is classified from its program logs and stored with the wallet's own
 * token and SOL changes, which the chain records exactly. Read-only.
 */
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { config } from "./config";
import { pg } from "./db";
import { apiFetch, createFailoverFetch } from "./rpc";

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
  "MemoSq4gqABAXKb96qnH8TzYVbnXsUX2Unuq9xCfLyf",
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

/** What a transaction did, from the instruction names its programs log. Meteora actions win over the rest: a
 * claim that also wraps SOL is still a claim. */
export function instructionNames(logs: string[]): string[] {
  return [...new Set(logs.map((l) => /Instruction: (\w+)/.exec(l)?.[1]).filter((n): n is string => !!n))];
}

export function classify(logs: string[]): string {
  const names = logs.map((l) => /Instruction: (\w+)/.exec(l)?.[1]).filter((n): n is string => !!n);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  // Order matters: closing a position also claims its fees, and withdrawing a filled limit order claims too, so
  // the bigger action is checked before the claim that rides along with it.
  if (has(/^RemoveLiquidity|^ClosePosition|^RemoveAllLiquidity/)) return "remove_liquidity";
  if (has(/^CancelLimitOrder|^CloseLimitOrder/)) return "limit_order_cancel";
  if (has(/^PlaceLimitOrder/)) return "limit_order_place";
  if (has(/^AddLiquidity|^InitializePosition/)) return "add_liquidity";
  if (has(/^ClaimFee/)) return "claim";
  if (has(/^(Route|SharedAccountsRoute|ExactOutRoute|SharedAccountsExactOutRoute|RouteV2|Swap|SwapV2|Fill)$/)) return "swap";
  // Nothing but plain token and SOL plumbing: a transfer in or out (airdrops and spam land here too).
  const programs = new Set(logs.map((l) => /^Program (\w{32,44}) invoke/.exec(l)?.[1]).filter((p): p is string => !!p));
  if (programs.size > 0 && [...programs].every((p) => PLUMBING.has(p))) return "transfer";
  return "other";
}

function changes(tx: ParsedTransactionWithMeta, owner: string): { sol: number; deltas: Omit<Delta, "symbol">[] } {
  const meta = tx.meta;
  if (!meta) return { sol: 0, deltas: [] };
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === owner);
  const sol = i >= 0 ? (meta.postBalances[i] - meta.preBalances[i]) / 1e9 : 0;
  const amount = (b: { uiTokenAmount: { uiAmountString?: string } }) => Number(b.uiTokenAmount.uiAmountString ?? 0);
  const byMint = new Map<string, number>();
  for (const b of meta.preTokenBalances ?? []) if (b.owner === owner) byMint.set(b.mint, (byMint.get(b.mint) ?? 0) - amount(b));
  for (const b of meta.postTokenBalances ?? []) if (b.owner === owner) byMint.set(b.mint, (byMint.get(b.mint) ?? 0) + amount(b));
  const deltas = [...byMint.entries()].filter(([, d]) => Math.abs(d) > 1e-12).map(([mint, d]) => ({ mint, amount: d }));
  return { sol, deltas };
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
      for (const { address } of rows) await this.sync(address);
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
    const records: { sig: string; ts: number; ok: boolean; kind: string; ix: string[]; sol: number; deltas: Omit<Delta, "symbol">[] }[] = [];
    for (const s of sigs) {
      const tx = await withRetry(() =>
        this.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }),
      );
      await sleep(GAP_MS);
      if (!tx) continue;
      const { sol, deltas } = changes(tx, owner);
      records.push({
        sig: s.signature,
        ts: (s.blockTime ?? tx.blockTime ?? Date.now() / 1000) * 1000,
        ok: !s.err,
        kind: classify(tx.meta?.logMessages ?? []),
        ix: instructionNames(tx.meta?.logMessages ?? []),
        sol,
        deltas,
      });
    }
    await nameMints(records.flatMap((r) => r.deltas.map((d) => d.mint)));
    for (const r of records) {
      const deltas: Delta[] = r.deltas.map((d) => ({ ...d, symbol: symbols.get(d.mint) ?? `${d.mint.slice(0, 4)}…` }));
      await pg.query(
        `insert into portfolio_activity (signature, wallet, ts, kind, source, ok, sol_delta, deltas, instructions)
         values ($1, $2, to_timestamp($3 / 1000.0), $4, 'chain', $5, $6, $7::jsonb, $8)
         on conflict (signature) do update set
           ts = excluded.ts, ok = excluded.ok, sol_delta = excluded.sol_delta, deltas = excluded.deltas,
           instructions = excluded.instructions,
           kind = case when portfolio_activity.source = 'app' then portfolio_activity.kind else excluded.kind end`,
        [r.sig, owner, r.ts, r.kind, r.ok, r.sol, JSON.stringify(deltas), r.ix],
      );
    }
    console.log(`[history] ${owner.slice(0, 4)}…: ${records.length} transaksi baru`);
    return records.length;
  }
}
