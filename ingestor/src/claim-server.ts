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
import { createFailoverFetch } from "./rpc";

const MAX_POSITIONS = 20;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type ClaimRequest = { owner: string; positions: { position: string; pool: string }[] };
type BuiltClaim = {
  position: string;
  pool: string;
  fee_x: string; // raw token units, as the program counts them
  fee_y: string;
  transactions: string[]; // base64, unsigned
};

let connection: Connection | null = null;
function rpc(): Connection {
  connection ??= new Connection(config.rpcProviders[0].httpUrl, {
    commitment: "confirmed",
    fetch: createFailoverFetch(config.rpcProviders),
  });
  return connection;
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

export async function buildClaims(req: ClaimRequest): Promise<{ claims: BuiltClaim[]; skipped: string[] }> {
  const conn = rpc();
  const owner = new PublicKey(req.owner);
  const byPool = new Map<string, string[]>();
  for (const p of req.positions) byPool.set(p.pool, [...(byPool.get(p.pool) ?? []), p.position]);

  const claims: BuiltClaim[] = [];
  const skipped: string[] = [];
  for (const [pool, positions] of byPool) {
    const dlmm = await DLMM.create(conn, new PublicKey(pool));
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
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const encoded: string[] = [];
      for (const tx of txs) {
        tx.feePayer = owner;
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        const sim = await conn.simulateTransaction(tx);
        if (sim.value.err) {
          const log = (sim.value.logs ?? []).slice(-3).join(" | ");
          throw new Error(`simulasi gagal untuk ${address}: ${JSON.stringify(sim.value.err)} ${log}`);
        }
        encoded.push(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
      }
      claims.push({ position: address, pool, fee_x: feeX.toString(), fee_y: feeY.toString(), transactions: encoded });
    }
  }
  return { claims, skipped };
}

type BinsResponse = {
  active_bin: number;
  lower_bin: number;
  upper_bin: number;
  bins: { bin: number; price: number; x: number; y: number }[];
};
const BINS_CACHE_MS = 60_000;
const binsCache = new Map<string, { at: number; value: BinsResponse }>();

/** Liquidity of one position per bin (display units), for the portfolio page's bin chart. Read-only. */
export async function positionBins(pool: string, position: string): Promise<BinsResponse> {
  const key = `${pool}:${position}`;
  const hit = binsCache.get(key);
  if (hit && Date.now() - hit.at < BINS_CACHE_MS) return hit.value;
  const dlmm = await DLMM.create(rpc(), new PublicKey(pool));
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
        return send(res, 200, await positionBins(pool, position), origin);
      } catch (err) {
        return send(res, 502, { detail: err instanceof Error ? err.message : "gagal membaca bin" }, origin);
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
