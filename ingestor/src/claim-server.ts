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
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey, type Transaction } from "@solana/web3.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { apiFetch, createFailoverFetch } from "./rpc";

const MAX_POSITIONS = 20;
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
function rpc(): Connection {
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
function serial<T>(job: () => Promise<T>): Promise<T> {
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
async function poolFor(address: string): Promise<DLMM> {
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
  verified: boolean;
  organic_score: number | null;
  to_sol: Quote;
  to_usdc: Quote;
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
      verified: t.verified,
      organic_score: t.organic_score,
      to_sol: sol ? await quote(t.mint, SOL_MINT, raw, 9, sol, inUsd).catch(() => null) : null,
      to_usdc: await quote(t.mint, USDC_MINT, raw, 6, 1, inUsd).catch(() => null),
    });
  }
  suggestCache.set(owner, { at: Date.now(), value: out });
  return out;
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
