/**
 * Builds unsigned "claim swap fee" transactions for the dashboard's Claim buttons.
 *
 * Nothing here can sign or send: the server holds no key. It returns serialized transactions with the user's wallet
 * as fee payer, and the wallet extension shows the balance changes and asks the user to approve. Every position is
 * checked to belong to the requesting wallet before a transaction is built, and each transaction is simulated here
 * first so a broken one is reported instead of being handed to the wallet.
 *
 * Listens on 127.0.0.1 only. The RPC key stays in this process; the browser never sees it.
 */
import DLMM, { deriveBinArray } from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, getTransferFeeConfig } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { apiFetch, createFailoverFetch } from "./rpc";
import { WalletHistory } from "./wallet-history";
import { botWallet } from "./auto-close";
import { pg } from "./db";

const MAX_POSITIONS = 20;
let history: WalletHistory | null = null;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type ClaimRequest = { owner: string; positions: { position: string; pool: string }[] };
type BuiltClaim = {
  position: string;
  pool: string;
  fee_x: string; // raw token units, as the program counts them
  fee_y: string;
  fee_x_ui: number; // display units, from the mint's decimals
  fee_y_ui: number;
  transactions: string[]; // base64, unsigned
  network_fee_lamports: number; // from the simulation-time fee calculator, before any priority fee
};

let connection: Connection | null = null;
export function rpc(): Connection {
  connection ??= new Connection(config.rpcProviders[0].httpUrl, {
    commitment: "confirmed",
    fetch: createFailoverFetch(config.rpcProviders),
  });
  return connection;
}

/**
 * Every SDK call from this server goes through one queue, one job at a time, with retries on rate limits. The
 * portfolio page asks for the bins of every position at once and a "claim all" builds several transactions: run
 * in parallel they burst past the RPC's per-second limit (HTTP 429) and the claim fails.
 */
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(() => withRetry(job));
  queue = run.catch(() => undefined);
  return run;
}

const isRateLimit = (err: unknown) => err instanceof Error && /429|too many requests|rate limit/i.test(err.message);

async function withRetry<T>(job: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await job();
    } catch (err) {
      if (!isRateLimit(err) || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1))); // 0.8s, 1.6s, 3.2s
    }
  }
}

// DLMM.create reads the pool, both mints and bin-array state: several RPC calls. Keep the instance and refresh
// only its state, which is one call.
const DLMM_TTL_MS = 10 * 60_000;
const pools = new Map<string, { at: number; dlmm: DLMM }>();
export async function poolFor(address: string): Promise<DLMM> {
  const hit = pools.get(address);
  if (hit && Date.now() - hit.at < DLMM_TTL_MS) {
    await hit.dlmm.refetchStates();
    return hit.dlmm;
  }
  const dlmm = await DLMM.create(rpc(), new PublicKey(address));
  pools.set(address, { at: Date.now(), dlmm });
  return dlmm;
}

function parse(body: unknown): ClaimRequest {
  const req = body as ClaimRequest;
  if (!req || typeof req.owner !== "string" || !BASE58.test(req.owner)) throw new Error("alamat wallet tidak valid");
  if (!Array.isArray(req.positions) || req.positions.length === 0) throw new Error("tidak ada posisi");
  if (req.positions.length > MAX_POSITIONS) throw new Error(`maksimal ${MAX_POSITIONS} posisi sekali claim`);
  for (const p of req.positions) {
    if (!BASE58.test(p?.position ?? "") || !BASE58.test(p?.pool ?? "")) throw new Error("alamat posisi tidak valid");
  }
  return req;
}

async function buildClaimsNow(req: ClaimRequest): Promise<{ claims: BuiltClaim[]; skipped: string[] }> {
  const conn = rpc();
  const owner = new PublicKey(req.owner);
  const byPool = new Map<string, string[]>();
  for (const p of req.positions) byPool.set(p.pool, [...(byPool.get(p.pool) ?? []), p.position]);

  const claims: BuiltClaim[] = [];
  const skipped: string[] = [];
  // One blockhash for the whole request: every transaction here is signed in the same wallet prompt anyway.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  for (const [pool, positions] of byPool) {
    const dlmm = await poolFor(pool);
    for (const address of positions) {
      const position = await dlmm.getPosition(new PublicKey(address));
      // The program would refuse anyway, but a clear error beats a failed simulation in someone else's wallet.
      if (!position.positionData.owner.equals(owner)) throw new Error(`posisi ${address} bukan milik wallet ini`);
      const { feeX, feeY } = position.positionData;
      if (feeX.isZero() && feeY.isZero()) {
        skipped.push(address);
        continue;
      }
      const txs: Transaction[] = await dlmm.claimSwapFee({ owner, position });
      const encoded: string[] = [];
      let networkFee = 0;
      for (const tx of txs) {
        tx.feePayer = owner;
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        const sim = await conn.simulateTransaction(tx);
        if (sim.value.err) {
          const log = (sim.value.logs ?? []).slice(-3).join(" | ");
          throw new Error(`simulasi gagal untuk ${address}: ${JSON.stringify(sim.value.err)} ${log}`);
        }
        // Base fee is 5000 lamports per signature; these carry only the owner's. Priority fees, if the SDK
        // added a compute-budget instruction, come on top and the wallet shows the exact total.
        networkFee += 5000 * tx.compileMessage().header.numRequiredSignatures;
        encoded.push(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
      }
      claims.push({
        position: address,
        pool,
        fee_x: feeX.toString(),
        fee_y: feeY.toString(),
        fee_x_ui: Number(feeX.toString()) / 10 ** dlmm.tokenX.mint.decimals,
        fee_y_ui: Number(feeY.toString()) / 10 ** dlmm.tokenY.mint.decimals,
        transactions: encoded,
        network_fee_lamports: networkFee,
      });
    }
  }
  return { claims, skipped };
}

export function buildClaims(req: ClaimRequest) {
  return serial(() => buildClaimsNow(req));
}

type BinsResponse = {
  active_bin: number;
  lower_bin: number;
  upper_bin: number;
  bins: { bin: number; price: number; x: number; y: number }[];
};
const BINS_CACHE_MS = 45_000;
const binsCache = new Map<string, { at: number; value: BinsResponse }>();

/** Liquidity of one position per bin (display units), for the portfolio page's bin chart. Read-only. */
export async function positionBins(pool: string, position: string, fresh = false): Promise<BinsResponse> {
  const key = `${pool}:${position}`;
  const hit = binsCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < BINS_CACHE_MS) return hit.value;
  return serial(() => readBins(key, pool, position));
}

async function readBins(key: string, pool: string, position: string): Promise<BinsResponse> {
  const dlmm = await poolFor(pool);
  const [pos, active] = await Promise.all([dlmm.getPosition(new PublicKey(position)), dlmm.getActiveBin()]);
  const dx = 10 ** dlmm.tokenX.mint.decimals;
  const dy = 10 ** dlmm.tokenY.mint.decimals;
  const value: BinsResponse = {
    active_bin: active.binId,
    lower_bin: pos.positionData.lowerBinId,
    upper_bin: pos.positionData.upperBinId,
    bins: pos.positionData.positionBinData.map((b) => ({
      bin: b.binId,
      price: Number(b.pricePerToken),
      x: Number(b.positionXAmount) / dx,
      y: Number(b.positionYAmount) / dy,
    })),
  };
  binsCache.set(key, { at: Date.now(), value });
  return value;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), // Token-2022
];
const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const WALLET_CACHE_MS = 30_000;

type WalletToken = {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  amount: number;
  price: number | null;
  value_usd: number | null;
  change_24h: number | null;
  change_1h: number | null;
  change_6h: number | null;
  verified: boolean;
  organic_score: number | null;
};
type WalletResponse = { owner: string; tokens: WalletToken[]; total_usd: number; fetched_at: number };
const walletCache = new Map<string, WalletResponse>();

type JupAsset = {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  usdPrice?: number;
  isVerified?: boolean;
  organicScore?: number;
  stats1h?: { priceChange?: number };
  stats6h?: { priceChange?: number };
  stats24h?: { priceChange?: number };
};

async function jupiterAssets(mints: string[]): Promise<Map<string, JupAsset>> {
  const out = new Map<string, JupAsset>();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const res = await apiFetch("jupiter", "assets/search", `${JUP_SEARCH}?query=${chunk.join(",")}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) continue; // prices missing for this chunk: balances still show
    for (const a of (await res.json()) as JupAsset[]) if (chunk.includes(a.id)) out.set(a.id, a);
  }
  return out;
}

/** SOL and every SPL / Token-2022 balance of a wallet, priced from Jupiter. Read-only; LP positions are not
 * tokens and are not included here. */
async function readWallet(owner: string): Promise<WalletResponse> {
  const conn = rpc();
  const key = new PublicKey(owner);
  const lamports = await conn.getBalance(key);
  const balances = new Map<string, number>([[SOL_MINT, lamports / 1e9]]);
  for (const programId of TOKEN_PROGRAMS) {
    const { value } = await conn.getParsedTokenAccountsByOwner(key, { programId });
    for (const acc of value) {
      const info = acc.account.data.parsed?.info;
      const amount = Number(info?.tokenAmount?.uiAmountString ?? 0);
      if (!info?.mint || !(amount > 0)) continue;
      // Wrapped SOL in a token account counts with native SOL: to the user both are just "SOL".
      balances.set(info.mint, (balances.get(info.mint) ?? 0) + amount);
    }
  }
  const assets = await jupiterAssets([...balances.keys()]);
  const tokens: WalletToken[] = [...balances.entries()].map(([mint, amount]) => {
    const a = assets.get(mint);
    const price = typeof a?.usdPrice === "number" ? a.usdPrice : null;
    return {
      mint,
      symbol: a?.symbol ?? (mint === SOL_MINT ? "SOL" : `${mint.slice(0, 4)}…`),
      name: a?.name ?? "Token tidak dikenal",
      icon: a?.icon ?? null,
      amount,
      price,
      value_usd: price == null ? null : price * amount,
      change_24h: a?.stats24h?.priceChange ?? null,
      change_1h: a?.stats1h?.priceChange ?? null,
      change_6h: a?.stats6h?.priceChange ?? null,
      verified: !!a?.isVerified,
      organic_score: a?.organicScore ?? null,
    };
  });
  tokens.sort((x, y) => (y.value_usd ?? -1) - (x.value_usd ?? -1));
  return { owner, tokens, total_usd: tokens.reduce((n, t) => n + (t.value_usd ?? 0), 0), fetched_at: Date.now() };
}

export async function walletTokens(owner: string, fresh = false): Promise<WalletResponse> {
  const hit = walletCache.get(owner);
  if (hit && !fresh && Date.now() - hit.fetched_at < WALLET_CACHE_MS) return hit;
  const value = await serial(() => readWallet(owner));
  walletCache.set(owner, value);
  return value;
}

// The user's core assets: anything else is a candidate to swap back into one of these. jlUSDC is Jupiter Lend's
// interest-bearing USDC, redeemable 1:1, so it counts as USDC rather than something to sell.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CORE_MINTS = new Set([SOL_MINT, USDC_MINT, "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D"]);
const SUGGEST_MIN_USD = 1;
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const SUGGEST_CACHE_MS = 60_000;
const suggestCache = new Map<string, { at: number; value: SwapSuggestion[] }>();

type Quote = { out_amount: number; out_usd: number; cost_pct: number; route: string[] } | null;
type SwapSuggestion = {
  mint: string;
  symbol: string;
  amount: number;
  value_usd: number;
  change_24h: number | null;
  change_1h: number | null;
  change_6h: number | null;
  verified: boolean;
  organic_score: number | null;
  to_sol: Quote;
  to_usdc: Quote;
  // Deepest Meteora pool per quote where a sell limit order can sit, if any.
  lo_pool_sol: LoPool | null;
  lo_pool_usdc: LoPool | null;
};

async function quote(input: string, output: string, rawAmount: string, outDecimals: number, outPrice: number, inUsd: number): Promise<Quote> {
  const url = `${JUP_QUOTE}?inputMint=${input}&outputMint=${output}&amount=${rawAmount}&slippageBps=100`;
  const res = await apiFetch("jupiter", "quote", url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const q = (await res.json()) as { outAmount?: string; routePlan?: { swapInfo?: { label?: string } }[] };
  if (!q.outAmount) return null;
  const out = Number(q.outAmount) / 10 ** outDecimals;
  const outUsd = out * outPrice;
  return {
    out_amount: out,
    out_usd: outUsd,
    // What the swap costs in value, from the output against the input at market prices: pool fees, price impact
    // and route overhead together. Clearer to the reader than Jupiter's own impact figure, which leaves fees out.
    cost_pct: inUsd > 0 ? Math.max(0, (1 - outUsd / inUsd) * 100) : 0,
    route: (q.routePlan ?? []).map((r) => r.swapInfo?.label ?? "?"),
  };
}

/** Quotes to SOL and to USDC for every non-core coin worth at least SUGGEST_MIN_USD. Read-only: quotes, no swap. */
export async function swapSuggestions(owner: string): Promise<SwapSuggestion[]> {
  const hit = suggestCache.get(owner);
  if (hit && Date.now() - hit.at < SUGGEST_CACHE_MS) return hit.value;
  const wallet = await walletTokens(owner);
  const sol = wallet.tokens.find((t) => t.mint === SOL_MINT)?.price ?? null;
  const candidates = wallet.tokens.filter(
    (t) => !CORE_MINTS.has(t.mint) && (t.value_usd ?? 0) >= SUGGEST_MIN_USD && t.price != null,
  );
  const out: SwapSuggestion[] = [];
  for (const t of candidates) {
    // Raw amount from the token's decimals, which Jupiter reports alongside the price.
    const decimals = (await jupiterAssets([t.mint])).get(t.mint) as (JupAsset & { decimals?: number }) | undefined;
    const d = decimals?.decimals ?? 6;
    const raw = BigInt(Math.floor(t.amount * 10 ** d)).toString();
    const inUsd = t.value_usd ?? 0;
    out.push({
      mint: t.mint,
      symbol: t.symbol,
      amount: t.amount,
      value_usd: inUsd,
      change_24h: t.change_24h,
      change_1h: t.change_1h,
      change_6h: t.change_6h,
      verified: t.verified,
      organic_score: t.organic_score,
      to_sol: sol ? await quote(t.mint, SOL_MINT, raw, 9, sol, inUsd).catch(() => null) : null,
      to_usdc: await quote(t.mint, USDC_MINT, raw, 6, 1, inUsd).catch(() => null),
      ...(await limitOrderPools(t.mint)
        .then((pools) => ({
          lo_pool_sol: pools.find((p) => p.quote === "SOL") ?? null,
          lo_pool_usdc: pools.find((p) => p.quote === "USDC") ?? null,
        }))
        .catch(() => ({ lo_pool_sol: null, lo_pool_usdc: null }))),
    });
  }
  suggestCache.set(owner, { at: Date.now(), value: out });
  return out;
}

// ---- Limit orders ----------------------------------------------------------------------------------------------
// Meteora's native limit orders: tokens placed in bins above the price are sold as the price climbs through them,
// and what has filled stays filled (unlike an LP position, it does not turn back if the price falls again).

const MAX_ORDER_BINS = 20;

type LoPool = { address: string; name: string; quote: string; bin_step: number; tvl: number; price: number };

/** Pools where `mint` is token X against SOL or USDC, deepest first: where a sell order can be placed. */
export async function limitOrderPools(mint: string): Promise<LoPool[]> {
  const url = `${config.meteoraApi}/pools?page=1&page_size=30&query=${mint}&sort_by=tvl:desc`;
  const res = await apiFetch("meteora", "pools", url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Meteora API ${res.status}`);
  const body = (await res.json()) as {
    data: { address: string; name: string; tvl: number; current_price: number; pool_config?: { bin_step: number };
      token_x: { address: string }; token_y: { address: string; symbol: string } }[];
  };
  return body.data
    .filter((p) => p.token_x.address === mint && (p.token_y.address === SOL_MINT || p.token_y.address === USDC_MINT))
    .slice(0, 6)
    .map((p) => ({
      address: p.address,
      name: p.name,
      quote: p.token_y.symbol,
      bin_step: p.pool_config?.bin_step ?? 0,
      tvl: p.tvl,
      price: p.current_price,
    }));
}

type PlaceRequest = { owner: string; pool: string; amount: number; start_pct: number; end_pct: number; bins: number; side?: "buy" | "sell" };

function parsePlace(body: unknown): PlaceRequest {
  const r = body as PlaceRequest;
  if (!r || !BASE58.test(r.owner ?? "") || !BASE58.test(r.pool ?? "")) throw new Error("alamat tidak valid");
  if (!(r.amount > 0)) throw new Error("jumlah harus lebih dari 0");
  if (!(r.start_pct > 0) || !(r.end_pct >= r.start_pct) || r.end_pct > 500) throw new Error("rentang harga tidak valid");
  if (!Number.isInteger(r.bins) || r.bins < 1 || r.bins > MAX_ORDER_BINS) throw new Error(`jumlah bin 1-${MAX_ORDER_BINS}`);
  if (r.side && r.side !== "buy" && r.side !== "sell") throw new Error("side harus buy atau sell");
  if (r.side === "buy" && r.end_pct >= 90) throw new Error("rentang beli terlalu jauh");
  return r;
}

async function placeNow(r: PlaceRequest) {
  const conn = rpc();
  const owner = new PublicKey(r.owner);
  const dlmm = await poolFor(r.pool);
  const active = await dlmm.getActiveBin();
  const price = Number(active.pricePerToken);
  const step = dlmm.lbPair.binStep;
  // Sell (ask): token X in bins above the price, start_pct..end_pct above it. Buy (bid): the quote token Y in bins
  // below the price, start_pct..end_pct below it. Either way strictly off the active bin, which would fill at once.
  const buying = r.side === "buy";
  const binAt = (pct: number, min: boolean) => dlmm.getBinIdFromPrice(Number(dlmm.toPricePerLamport(price * (1 + pct / 100))), min);
  const lo = buying
    ? binAt(-r.end_pct, true)
    : Math.max(active.binId + 1, binAt(r.start_pct, true));
  const hi = buying
    ? Math.min(active.binId - 1, Math.max(lo, binAt(-r.start_pct, false)))
    : Math.max(lo, binAt(r.end_pct, false));
  if (hi < lo) throw new Error("rentang harga terlalu dekat dengan harga sekarang");
  const count = Math.min(r.bins, hi - lo + 1);
  const ids = Array.from({ length: count }, (_, i) => (count === 1 ? lo : Math.round(lo + ((hi - lo) * i) / (count - 1))));
  const unique = [...new Set(ids)];

  const side = buying ? dlmm.tokenY : dlmm.tokenX;
  const decimalsX = side.mint.decimals; // decimals of the token being deposited
  // Token-2022 coins with a transfer fee (GP charges ~3%) cost the amount plus the fee to deposit, so an order for
  // the whole balance fails. Cap the order at what the balance can actually cover after the fee.
  const { feeBps, maxFee } = await transferFee(conn, side.publicKey);
  // Native SOL sits in the wallet, not a token account; the SDK wraps what the order needs.
  const balance =
    side.publicKey.toBase58() === SOL_MINT
      ? BigInt(Math.max(0, (await conn.getBalance(owner)) - 10_000_000)) // keep 0.01 SOL for fees and rent
      : await tokenBalance(conn, owner, side.publicKey, side.owner);
  const affordable = feeBps > 0 ? (balance * BigInt(10_000 - feeBps)) / 10_000n : balance;
  const capped = maxFee != null && balance - affordable > maxFee ? balance - maxFee : affordable;
  const requested = BigInt(Math.floor(r.amount * 10 ** decimalsX));
  const total = requested > capped ? (capped * 9995n) / 10_000n : requested; // small margin for rounding
  if (total <= 0n) throw new Error("saldo token tidak cukup");
  const each = total / BigInt(unique.length);
  if (each <= 0n) throw new Error("jumlah terlalu kecil untuk dibagi ke bin");
  const bins = unique.map((id, i) => ({
    id,
    // The last bin takes the rounding remainder, so exactly `amount` leaves the wallet.
    amount: new BN((i === unique.length - 1 ? total - each * BigInt(unique.length - 1) : each).toString()),
  }));

  // The order lives in a fresh account whose key must sign once, at creation. The key is made here, signs, and is
  // dropped: the order's owner is the user's wallet, and only the owner can cancel or withdraw.
  const orderKey = Keypair.generate();
  const tx: Transaction = await dlmm.placeLimitOrder({
    owner,
    payer: owner,
    sender: owner,
    limitOrder: orderKey.publicKey,
    params: { isAskSide: !buying, relativeBin: null, bins },
  });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.partialSign(orderKey);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(`simulasi gagal: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Anchor account namespace is untyped in the SDK
  const size = (dlmm as any).program.account.limitOrder.size as number | undefined;
  const rentLamports = size ? await conn.getMinimumBalanceForRentExemption(size) : 0;
  const binPrice = (id: number) => Number(dlmm.fromPricePerLamport(Number(getPrice(id, step))));
  const plan = bins.map((b) => {
    const amt = Number(b.amount.toString()) / 10 ** decimalsX;
    const p = binPrice(b.id);
    return { bin: b.id, price: p, amount: amt, output: buying ? amt / p : amt * p };
  });
  return {
    side: buying ? "buy" : "sell",
    amount: Number(total) / 10 ** decimalsX,
    amount_adjusted: total < requested,
    transfer_fee_bps: feeBps,
    order: orderKey.publicKey.toBase58(),
    pool: r.pool,
    active_price: price,
    bins: plan,
    expected_output: plan.reduce((n, b) => n + b.output, 0),
    network_fee_lamports: 5000 * tx.compileMessage().header.numRequiredSignatures,
    rent_lamports_estimate: rentLamports,
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
  };
}

async function transferFee(conn: Connection, mint: PublicKey): Promise<{ feeBps: number; maxFee: bigint | null }> {
  const info = await conn.getAccountInfo(mint);
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return { feeBps: 0, maxFee: null };
  const config = getTransferFeeConfig(await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID));
  if (!config) return { feeBps: 0, maxFee: null };
  const epoch = BigInt((await conn.getEpochInfo()).epoch);
  const fee = epoch >= config.newerTransferFee.epoch ? config.newerTransferFee : config.olderTransferFee;
  return { feeBps: fee.transferFeeBasisPoints, maxFee: fee.maximumFee };
}

async function tokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey, programId: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
  const res = await conn.getTokenAccountBalance(ata).catch(() => null);
  return res ? BigInt(res.value.amount) : 0n;
}

function getPrice(binId: number, binStep: number): number {
  return (1 + binStep / 10_000) ** binId; // price per lamport; fromPricePerLamport applies the decimals
}

export function placeLimitOrder(body: unknown) {
  const r = parsePlace(body);
  return serial(() => placeNow(r));
}

type CancelRequest = { owner: string; pool: string; order: string };

async function cancelNow(r: CancelRequest) {
  if (!BASE58.test(r.owner ?? "") || !BASE58.test(r.pool ?? "") || !BASE58.test(r.order ?? "")) throw new Error("alamat tidak valid");
  const conn = rpc();
  const owner = new PublicKey(r.owner);
  const dlmm = await poolFor(r.pool);
  const orderKey = new PublicKey(r.order);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK exposes the Anchor program untyped here
  const account = await (dlmm as any).program.account.limitOrder.fetch(orderKey);
  if (!account.owner.equals(owner)) throw new Error("order ini bukan milik wallet ini");
  if (!account.lbPair.equals(new PublicKey(r.pool))) throw new Error("order ini bukan di pool tersebut");
  const parsed = await dlmm.getLimitOrder(orderKey);
  const binIds = parsed.limitOrderData.limitOrderBinData.filter((b) => !b.empty).map((b) => b.binId);

  const tx: Transaction = await dlmm.cancelLimitOrder({ limitOrderPubkey: orderKey, owner, rentReceiver: owner, binIds });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(`simulasi gagal: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
  }
  const d = parsed.limitOrderData;
  return {
    order: r.order,
    // The parsed order already reports display units (checked against Meteora's own figures for a live order).
    receive_x: Number(d.transferFeeExcludedWithdrawableAmountX),
    receive_y: Number(d.transferFeeExcludedWithdrawableAmountY),
    token_x: pool_symbol(dlmm.tokenX.publicKey.toBase58()),
    token_y: pool_symbol(dlmm.tokenY.publicKey.toBase58()),
    network_fee_lamports: 5000,
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
  };
}

function pool_symbol(mint: string): string | null {
  return mint === SOL_MINT ? "SOL" : mint === USDC_MINT ? "USDC" : null; // the dashboard names the rest from the order
}

export function cancelLimitOrder(body: unknown) {
  return serial(() => cancelNow(body as CancelRequest));
}

const PRICE_CACHE_MS = 60_000;
const priceCache = new Map<string, { at: number; value: { price: number | null; symbol: string | null; icon: string | null } }>();

/** Current price, symbol and icon per mint (Jupiter), for putting a dollar figure and a face on history rows. */
export async function tokenInfo(mints: string[]) {
  const now = Date.now();
  const missing = mints.filter((m) => !(priceCache.get(m) && now - priceCache.get(m)!.at < PRICE_CACHE_MS));
  if (missing.length) {
    const assets = await jupiterAssets(missing);
    for (const m of missing) {
      const a = assets.get(m);
      priceCache.set(m, { at: now, value: { price: typeof a?.usdPrice === "number" ? a.usdPrice : null, symbol: a?.symbol ?? null, icon: a?.icon ?? null } });
    }
  }
  return Object.fromEntries(mints.map((m) => [m, priceCache.get(m)?.value ?? { price: null, symbol: null, icon: null }]));
}

// ---- Close a position and sell its memecoin: two transactions, the second built once the first has landed -----------

const JUP_SWAP = "https://lite-api.jup.ag/swap/v1/swap";
// Micro-lamports per compute unit. The floor gets the close into a busy block; the cap keeps a fee spike from
// costing more than ~0.0005 SOL at the limits these transactions use.
const CU_PRICE_MIN = 50_000;
const CU_PRICE_MAX = 1_000_000;
const SELL_SLIPPAGE_BPS = 300; // memecoins move fast: 3%, shown to the user before signing
const CONFIRM_TIMEOUT_MS = 45_000;

type CloseRequest = { owner: string; pool: string; position: string };

async function priorityPrice(conn: Connection, accounts: PublicKey[]): Promise<number> {
  const fees = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: accounts }).catch(() => []);
  const paid = fees.map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
  const p75 = paid.length ? paid[Math.floor(paid.length * 0.75)] : 0;
  return Math.min(CU_PRICE_MAX, Math.max(CU_PRICE_MIN, p75));
}

async function mintProgram(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint);
  return info?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAMS[0];
}

async function buildCloseNow(r: CloseRequest) {
  if (!BASE58.test(r.owner ?? "") || !BASE58.test(r.pool ?? "") || !BASE58.test(r.position ?? "")) throw new Error("alamat tidak valid");
  const conn = rpc();
  const owner = new PublicKey(r.owner);
  const dlmm = await poolFor(r.pool);
  const pos = await dlmm.getPosition(new PublicKey(r.position));
  if (!pos.positionData.owner.equals(owner)) throw new Error("posisi ini bukan milik wallet ini");
  const d = pos.positionData;
  const mintX = dlmm.tokenX.publicKey;
  const mintY = dlmm.tokenY.publicKey;
  const decX = dlmm.tokenX.mint.decimals;
  const decY = dlmm.tokenY.mint.decimals;
  const rawX = BigInt(Math.floor(Number(d.totalXAmount))) + BigInt(d.feeX.toString());
  const rawY = BigInt(Math.floor(Number(d.totalYAmount))) + BigInt(d.feeY.toString());

  const txs: Transaction[] = await dlmm.removeLiquidity({
    user: owner,
    position: pos.publicKey,
    fromBinId: d.lowerBinId,
    toBinId: d.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });
  const price = await priorityPrice(conn, [new PublicKey(r.pool)]);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const encoded: string[] = [];
  let networkFee = 0;
  for (const tx of txs) {
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      throw new Error(`simulasi gagal: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
    }
    // The SDK asks for 1.4M compute units; the fee is price x limit, so size the limit to what the simulation used
    // (+20%) and add the priority price that gets the close in quickly.
    const units = Math.min(1_400_000, Math.ceil((sim.value.unitsConsumed ?? 400_000) * 1.2) + 10_000);
    tx.instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
      ...tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)),
    ];
    networkFee += 5000 * tx.compileMessage().header.numRequiredSignatures + Math.ceil((units * price) / 1e6);
    encoded.push(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
  }

  // The memecoin side is sold into the pool's other token when that is SOL or USDC, into SOL otherwise.
  const xCore = CORE_MINTS.has(mintX.toBase58());
  const yCore = CORE_MINTS.has(mintY.toBase58());
  const sellX = !xCore ? true : !yCore ? false : null;
  let sell = null;
  if (sellX !== null) {
    const mint = sellX ? mintX : mintY;
    const raw = sellX ? rawX : rawY;
    const output = sellX ? (yCore ? mintY : new PublicKey(SOL_MINT)) : xCore ? mintX : new PublicKey(SOL_MINT);
    const program = await mintProgram(conn, mint);
    const before = await tokenBalance(conn, owner, mint, program);
    const { feeBps } = await transferFee(conn, mint);
    const received = (raw * BigInt(10_000 - feeBps)) / 10_000n;
    const info = await tokenInfo([mint.toBase58(), output.toBase58()]);
    const inPrice = info[mint.toBase58()]?.price ?? 0;
    const outPrice = info[output.toBase58()]?.price ?? 0;
    const dec = sellX ? decX : decY;
    const outDec = output.equals(mintX) ? decX : output.equals(mintY) ? decY : 9;
    const amountUi = Number(received) / 10 ** dec;
    sell = {
      mint: mint.toBase58(),
      symbol: info[mint.toBase58()]?.symbol ?? "?",
      output: output.toBase58(),
      output_symbol: output.toBase58() === SOL_MINT ? "SOL" : (info[output.toBase58()]?.symbol ?? "?"),
      amount_ui: amountUi,
      value_usd: amountUi * inPrice,
      before_raw: before.toString(),
      slippage_bps: SELL_SLIPPAGE_BPS,
      quote: received > 0n && outPrice > 0 ? await quote(mint.toBase58(), output.toBase58(), received.toString(), outDec, outPrice, amountUi * inPrice).catch(() => null) : null,
    };
  }
  return {
    position: r.position,
    pool: r.pool,
    token_x: mintX.toBase58(),
    token_y: mintY.toBase58(),
    receive_x: Number(rawX) / 10 ** decX,
    receive_y: Number(rawY) / 10 ** decY,
    fee_x: Number(d.feeX.toString()) / 10 ** decX,
    fee_y: Number(d.feeY.toString()) / 10 ** decY,
    transactions: encoded,
    network_fee_lamports: networkFee,
    priority_micro_lamports: price,
    sell,
  };
}

export function buildClose(body: unknown) {
  return serial(() => buildCloseNow(body as CloseRequest));
}

type SellRequest = { owner: string; mint: string; output: string; before_raw: string; signatures: string[]; slippage_bps?: number };

async function waitConfirmed(conn: Connection, signatures: string[]) {
  const until = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < until) {
    const { value } = await conn.getSignatureStatuses(signatures);
    const failed = value.find((s) => s?.err);
    if (failed) throw new Error(`penutupan posisi gagal di chain: ${JSON.stringify(failed.err)}`);
    if (value.every((s) => s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"))) return;
    await new Promise((res) => setTimeout(res, 600));
  }
  throw new Error("penutupan posisi belum terkonfirmasi setelah 45 detik; cek wallet lalu jual dari tab Wallet");
}

/** After the close has landed: sells exactly what it brought in (balance now minus balance before) via Jupiter. */
export async function buildSell(body: unknown) {
  const r = body as SellRequest;
  if (![r?.owner, r?.mint, r?.output].every((a) => BASE58.test(a ?? ""))) throw new Error("alamat tidak valid");
  if (!Array.isArray(r.signatures) || r.signatures.length === 0 || r.signatures.length > 10) throw new Error("signature tidak valid");
  const conn = rpc();
  await waitConfirmed(conn, r.signatures);
  const owner = new PublicKey(r.owner);
  const mint = new PublicKey(r.mint);
  const now = await tokenBalance(conn, owner, mint, await mintProgram(conn, mint));
  const amount = now - BigInt(r.before_raw || "0");
  if (amount <= 0n) throw new Error("token dari posisi belum terlihat di wallet");
  const slippage = Math.min(1000, Math.max(50, Math.round(r.slippage_bps ?? SELL_SLIPPAGE_BPS)));
  const qUrl = `${JUP_QUOTE}?inputMint=${r.mint}&outputMint=${r.output}&amount=${amount}&slippageBps=${slippage}`;
  const qRes = await apiFetch("jupiter", "quote", qUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!qRes.ok) throw new Error(`Jupiter tidak memberi harga (HTTP ${qRes.status})`);
  const quoteResponse = (await qRes.json()) as { outAmount?: string; routePlan?: { swapInfo?: { label?: string } }[] };
  if (!quoteResponse.outAmount) throw new Error("Jupiter tidak menemukan rute jual");
  const sRes = await apiFetch("jupiter", "swap", JUP_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: r.owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 500_000, priorityLevel: "veryHigh" } },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const swap = (await sRes.json()) as { swapTransaction?: string; error?: string };
  if (!sRes.ok || !swap.swapTransaction) throw new Error(`Jupiter gagal menyusun swap: ${swap.error ?? sRes.status}`);
  const outDec = r.output === SOL_MINT ? 9 : (await getMint(conn, new PublicKey(r.output))).decimals;
  return {
    transaction: swap.swapTransaction,
    amount_raw: amount.toString(),
    out_amount: Number(quoteResponse.outAmount) / 10 ** outDec,
    route: (quoteResponse.routePlan ?? []).map((p) => p.swapInfo?.label ?? "?"),
  };
}

function send(res: ServerResponse, status: number, body: unknown, origin: string) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error("request terlalu besar");
  }
  return JSON.parse(raw || "null");
}

export function startClaimServer(port = config.claimPort, allowed = config.dashboardOrigins) {
  const server = createServer(async (req, res) => {
    // Only the dashboard may call this: a random site open in the same browser must not be able to ask for
    // transactions built against this machine's RPC.
    const origin = allowed.includes(req.headers.origin ?? "") ? (req.headers.origin as string) : "null";
    if (req.method === "OPTIONS") return send(res, 204, {}, origin);
    if (req.headers.origin && origin === "null") return send(res, 403, { detail: "origin" }, origin);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/bins") {
      const pool = url.searchParams.get("pool") ?? "";
      const position = url.searchParams.get("position") ?? "";
      if (!BASE58.test(pool) || !BASE58.test(position)) return send(res, 400, { detail: "alamat tidak valid" }, origin);
      try {
        return send(res, 200, await positionBins(pool, position, url.searchParams.get("fresh") === "1"), origin);
      } catch (err) {
        return send(res, 502, { detail: err instanceof Error ? err.message : "gagal membaca bin" }, origin);
      }
    }
    if (req.method === "GET" && url.pathname === "/wallet") {
      const owner = url.searchParams.get("owner") ?? "";
      if (!BASE58.test(owner)) return send(res, 400, { detail: "alamat wallet tidak valid" }, origin);
      try {
        return send(res, 200, await walletTokens(owner, url.searchParams.get("fresh") === "1"), origin);
      } catch (err) {
        return send(res, 502, { detail: err instanceof Error ? err.message : "gagal membaca wallet" }, origin);
      }
    }
    if (req.method === "GET" && url.pathname === "/swap-suggestions") {
      const owner = url.searchParams.get("owner") ?? "";
      if (!BASE58.test(owner)) return send(res, 400, { detail: "alamat wallet tidak valid" }, origin);
      try {
        return send(res, 200, { owner, suggestions: await swapSuggestions(owner) }, origin);
      } catch (err) {
        return send(res, 502, { detail: err instanceof Error ? err.message : "gagal mengambil quote" }, origin);
      }
    }
    if (req.method === "GET" && url.pathname === "/bin-arrays") {
      // Which bin arrays a range from the active bin down to `low_pct` below the price would need, and how many of
      // them do not exist yet: each new one costs 0.0714 SOL of rent that never comes back.
      const pool = url.searchParams.get("pool") ?? "";
      const lowPct = Number(url.searchParams.get("low_pct") ?? "-90");
      if (!BASE58.test(pool) || !(lowPct < 0 && lowPct > -100)) return send(res, 400, { detail: "parameter tidak valid" }, origin);
      try {
        const dlmm = await DLMM.create(rpc(), new PublicKey(pool));
        const active = dlmm.lbPair.activeId;
        const step = dlmm.lbPair.binStep;
        const lower = active + Math.floor(Math.log(1 + lowPct / 100) / Math.log(1 + step / 10_000));
        const first = Math.floor(lower / 70);
        const last = Math.floor(active / 70);
        const indexes = Array.from({ length: last - first + 1 }, (_, i) => first + i);
        const keys = indexes.map((i) => deriveBinArray(new PublicKey(pool), new BN(i), dlmm.program.programId)[0]);
        const infos = await rpc().getMultipleAccountsInfo(keys);
        const missing = indexes.filter((_, i) => !infos[i]);
        return send(res, 200, {
          pool, active_id: active, bin_step: step, lower_bin: lower, bins: active - lower + 1,
          arrays: indexes.length, new_arrays: missing.length,
        }, origin);
      } catch (err) {
        return send(res, 502, { detail: err instanceof Error ? err.message : "gagal membaca pool" }, origin);
      }
    }
    if (req.method === "GET" && url.pathname === "/history/sync") {
      // On demand (a Refresh on the net-result page): read the wallet's newest transactions now instead of waiting
      // for the 5-minute sync, so a position closed a minute ago is counted with its exit.
      const owner = url.searchParams.get("owner") ?? "";
      if (!BASE58.test(owner)) return send(res, 400, { detail: "alamat wallet tidak valid" }, origin);
      try {
        history ??= new WalletHistory();
        const added = (await history.sync(owner)) + (await history.syncTokenAccounts(owner));
        return send(res, 200, { added }, origin);
      } catch (err) {
        return send(res, 502, { detail: err instanceof Error ? err.message : "sync gagal" }, origin);
      }
    }
    if (req.method === "GET" && url.pathname === "/prices") {
      const mints = (url.searchParams.get("mints") ?? "").split(",").filter((m) => BASE58.test(m)).slice(0, 200);
      try {
        return send(res, 200, { tokens: await tokenInfo(mints) }, origin);
      } catch (err) {
        return send(res, 502, { detail: err instanceof Error ? err.message : "gagal" }, origin);
      }
    }
    if (req.method === "GET" && url.pathname === "/lo-pools") {
      const mint = url.searchParams.get("mint") ?? "";
      if (!BASE58.test(mint)) return send(res, 400, { detail: "mint tidak valid" }, origin);
      try {
        return send(res, 200, { pools: await limitOrderPools(mint) }, origin);
      } catch (err) {
        return send(res, 502, { detail: err instanceof Error ? err.message : "gagal" }, origin);
      }
    }
    if (req.method === "POST" && (url.pathname === "/limit-order" || url.pathname === "/limit-order/cancel")) {
      try {
        const body = await readJson(req);
        const out = url.pathname === "/limit-order" ? await placeLimitOrder(body) : await cancelLimitOrder(body);
        return send(res, 200, out, origin);
      } catch (err) {
        const message = err instanceof Error ? err.message : "gagal menyusun transaksi";
        console.warn(`[limit-order] ${message}`);
        return send(res, 400, { detail: message }, origin);
      }
    }
    if (url.pathname === "/auto-close" && req.method === "GET") {
      // Which wallet the bot signs for, and the armed/finished positions: the dashboard's toggles read this.
      const kp = botWallet();
      const { rows } = await pg.query(
        `select position, pool, owner, enabled, target_pct, status, basis_usd, last_net_pct, last_checked_at, close_sigs,
                sell_sig, result_usd, error from auto_close order by updated_at desc limit 200`,
      );
      return send(res, 200, { bot_wallet: kp?.publicKey.toBase58() ?? null, positions: rows }, origin);
    }
    if (url.pathname === "/auto-close" && req.method === "POST") {
      try {
        const b = (await readJson(req)) as { position: string; pool: string; enabled: boolean; target_pct?: number };
        const kp = botWallet();
        if (!kp) throw new Error("wallet bot belum diatur (BOT_WALLET_SECRET di .env)");
        if (!BASE58.test(b?.position ?? "") || !BASE58.test(b?.pool ?? "")) throw new Error("alamat tidak valid");
        const target = Math.min(20, Math.max(1, Number(b.target_pct ?? 4)));
        if (b.enabled) {
          // Refuse positions the bot cannot close: it must own them.
          const dlmm = await serial(() => poolFor(b.pool));
          const pos = await serial(() => dlmm.getPosition(new PublicKey(b.position)));
          if (!pos.positionData.owner.equals(kp.publicKey)) throw new Error("posisi ini bukan milik wallet bot");
        }
        await pg.query(
          `insert into auto_close (position, pool, owner, enabled, target_pct, status)
           values ($1, $2, $3, $4, $5, 'armed')
           on conflict (position) do update set enabled = excluded.enabled, target_pct = excluded.target_pct,
             status = case when auto_close.status in ('done', 'closing') then auto_close.status else 'armed' end,
             error = null, updated_at = now()`,
          [b.position, b.pool, kp.publicKey.toBase58(), !!b.enabled, target],
        );
        return send(res, 200, { ok: true }, origin);
      } catch (err) {
        return send(res, 400, { detail: err instanceof Error ? err.message : "gagal" }, origin);
      }
    }
    if (req.method === "POST" && (url.pathname === "/close" || url.pathname === "/close/sell")) {
      try {
        const body = await readJson(req);
        return send(res, 200, url.pathname === "/close" ? await buildClose(body) : await buildSell(body), origin);
      } catch (err) {
        const message = err instanceof Error ? err.message : "gagal menyusun transaksi";
        console.warn(`[close] ${message}`);
        return send(res, 400, { detail: message }, origin);
      }
    }
    if (req.method !== "POST" || url.pathname !== "/claim") return send(res, 404, { detail: "not found" }, origin);
    try {
      const built = await buildClaims(parse(await readJson(req)));
      send(res, 200, built, origin);
    } catch (err) {
      const message = err instanceof Error ? err.message : "gagal menyusun transaksi";
      console.warn(`[claim] ${message}`);
      send(res, 400, { detail: message }, origin);
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`[claim] tx builder on 127.0.0.1:${port}`));
  return server;
}
