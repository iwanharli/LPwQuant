/**
 * What a transaction cost the wallet besides the trade itself: the network + priority fee (exact, from the
 * transaction), and the pool fee paid on each Meteora DLMM swap in it (exact, from the program's Swap events, which
 * the current program emits as inner instructions to its event authority). Swap hops through other DEXes carry no
 * fee that can be read the same way, so they are flagged instead of guessed.
 */
import { BorshCoder, utils } from "@coral-xyz/anchor";
import { IDL, LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { config } from "./config";
import { pg } from "./db";
import { apiFetch } from "./rpc";

const LB = LBCLMM_PROGRAM_IDS["mainnet-beta"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's IDL type does not match anchor's generic
const coder = new BorshCoder(IDL as any);

// Programs whose swaps pay a pool fee we cannot decode here.
const OTHER_DEXES = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", // Raydium LaunchLab
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora DAMM v1
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", // Meteora DBC
  "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", // Lifinity v2
  "SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe", // SolFi
]);

type PoolMints = { mintX: string; mintY: string; decX: number; decY: number };
const pools = new Map<string, PoolMints | null>();

async function poolMints(address: string): Promise<PoolMints | null> {
  if (pools.has(address)) return pools.get(address)!;
  const { rows } = await pg.query<{ mint_x: string; mint_y: string; decimals_x: number; decimals_y: number }>(
    "select mint_x, mint_y, decimals_x, decimals_y from pools where address = $1",
    [address],
  );
  let value: PoolMints | null = rows[0]
    ? { mintX: rows[0].mint_x, mintY: rows[0].mint_y, decX: rows[0].decimals_x, decY: rows[0].decimals_y }
    : null;
  if (!value) {
    try {
      const res = await apiFetch("meteora", "pool", `${config.meteoraApi}/pools/${address}`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const p = (await res.json()) as { token_x: { address: string; decimals: number }; token_y: { address: string; decimals: number } };
        value = { mintX: p.token_x.address, mintY: p.token_y.address, decX: p.token_x.decimals, decY: p.token_y.decimals };
      }
    } catch {
      // unknown pool: its fee is left out and the swap flagged
    }
  }
  pools.set(address, value);
  return value;
}

export type TxCosts = { networkFeeLamports: number | null; poolFees: { mint: string; amount: number }[]; otherDexSwap: boolean };

export async function costsOf(tx: ParsedTransactionWithMeta): Promise<TxCosts> {
  const meta = tx.meta;
  const fees = new Map<string, number>();
  let undecoded = false;
  // Newer programs emit Swap2Evt next to Swap, and only Swap2Evt says which token the fee was taken in (a pool can
  // charge it on the output: a USDC -> TACZ swap paid its fee in TACZ). So Swap2Evt wins when present; the old Swap
  // event (fee always on the input) is used only in transactions that have no Swap2Evt.
  type Evt = { name: string; data: Record<string, { toString(): string; toBase58?(): string } | boolean> };
  const events: Evt[] = [];
  for (const group of meta?.innerInstructions ?? []) {
    for (const ix of group.instructions as { programId?: { toBase58(): string }; data?: string }[]) {
      if (ix.programId?.toBase58() !== LB || !ix.data) continue;
      try {
        const ev = coder.events.decode(Buffer.from(utils.bytes.bs58.decode(ix.data)).subarray(8).toString("base64"));
        if (ev && (ev.name === "Swap" || ev.name === "Swap2Evt")) events.push(ev as unknown as Evt);
      } catch {
        // not an event
      }
    }
  }
  const useNew = events.some((e) => e.name === "Swap2Evt");
  for (const ev of events.filter((e) => e.name === (useNew ? "Swap2Evt" : "Swap"))) {
    const d = ev.data as Record<string, { toString(): string; toBase58(): string }> & { swap_for_y: boolean; fees_on_token_x?: boolean };
    const p = await poolMints(d.lb_pair.toBase58());
    if (!p) {
      undecoded = true;
      continue;
    }
    let onX: boolean;
    let raw: number;
    if (useNew) {
      onX = !!d.fees_on_token_x;
      raw = ["mm_fee", "protocol_fee", "limit_order_fee", "host_fee"].reduce((n, k) => n + Number(d[k]?.toString() ?? 0), 0);
    } else {
      onX = d.swap_for_y; // fee on the input: X when swapping X for Y
      raw = Number(d.fee.toString());
    }
    const mint = onX ? p.mintX : p.mintY;
    fees.set(mint, (fees.get(mint) ?? 0) + raw / 10 ** (onX ? p.decX : p.decY));
  }
  const programs = new Set(
    (meta?.logMessages ?? []).map((l) => /^Program (\w{32,44}) invoke/.exec(l)?.[1]).filter((p): p is string => !!p),
  );
  const otherDexSwap = undecoded || [...programs].some((p) => OTHER_DEXES.has(p));
  return {
    networkFeeLamports: meta ? meta.fee : null,
    poolFees: [...fees.entries()].map(([mint, amount]) => ({ mint, amount })),
    otherDexSwap,
  };
}
