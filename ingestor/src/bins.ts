import { Connection, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  binIdToBinArrayIndex,
  createProgram,
  decodeAccount,
  deriveBinArray,
  LBCLMM_PROGRAM_IDS,
  type BinArray,
  type LbPair,
} from "@meteora-ag/dlmm";
import { config } from "./config";
import type { PoolSnapshot } from "./meteora";
import { redis } from "./redis";
import { createFailoverFetch } from "./rpc";

export const BINS_LATEST_KEY = "bins:latest";

const BINS_PER_ARRAY = 70;
const PROGRAM_ID = new PublicKey(LBCLMM_PROGRAM_IDS["mainnet-beta"]);

/** Liquidity around the active bin, shared with the engine (snake_case on purpose). */
export interface BinDepth {
  ts: number;
  active_id: number;
  bin_step: number;
  /** Bin array indexes that were scanned, inclusive; `initialized` lists the ones that exist on-chain. */
  array_lo: number;
  array_hi: number;
  initialized: number[];
  /** [bin id offset from active, liquidity valued in token Y (UI units)] for non-empty bins. */
  bins: [number, number][];
}

function amount(value: BN): number {
  return Number(value.toString());
}

/**
 * Reads bin arrays around each pool's active bin so the engine can estimate a position's real fee share
 * (fees only go to liquidity in the bins that trade, not to the whole TVL) and whether opening a range
 * must pay rent for bin arrays nobody has created yet. Per refresh: one getMultipleAccounts for the
 * pairs, then one per 100 bin arrays.
 */
export class BinDepthFetcher {
  private readonly connection: Connection;
  private readonly program: ReturnType<typeof createProgram>;
  private lastRun = 0;
  private running = false;
  lastCount = 0;

  constructor() {
    this.connection = new Connection(config.rpcProviders[0].httpUrl, {
      commitment: "confirmed",
      fetch: createFailoverFetch(config.rpcProviders),
    });
    this.program = createProgram(this.connection);
  }

  /** Top pools by volume plus pools with open paper positions, at most once per refresh interval. */
  maybeRefresh(pools: PoolSnapshot[], pinned: string[]): void {
    if (this.running || Date.now() - this.lastRun < config.binsRefreshMs) return;
    const pin = new Set(pinned);
    const targets = [...pools.slice(0, config.binsTopN), ...pools.slice(config.binsTopN).filter((p) => pin.has(p.address))];
    this.running = true;
    this.lastRun = Date.now();
    this.refresh(targets)
      .catch((err) => console.error("[bins] refresh failed", err instanceof Error ? err.message : err))
      .finally(() => {
        this.running = false;
      });
  }

  private async refresh(pools: PoolSnapshot[]): Promise<void> {
    const pairs = new Map<string, LbPair>();
    for (let i = 0; i < pools.length; i += 100) {
      const chunk = pools.slice(i, i + 100);
      const infos = await this.connection.getMultipleAccountsInfo(chunk.map((p) => new PublicKey(p.address)));
      infos.forEach((info, idx) => {
        if (!info) return;
        try {
          pairs.set(chunk[idx].address, decodeAccount<LbPair>(this.program, "lbPair", info.data));
        } catch {
          // not a DLMM pair account; skip
        }
      });
    }

    const span = config.binsArraysEachSide;
    const wanted: { address: string; index: number; key: PublicKey }[] = [];
    for (const pool of pools) {
      const pair = pairs.get(pool.address);
      if (!pair) continue;
      const center = binIdToBinArrayIndex(new BN(pair.activeId)).toNumber();
      for (let index = center - span; index <= center + span; index++) {
        wanted.push({ address: pool.address, index, key: deriveBinArray(new PublicKey(pool.address), new BN(index), PROGRAM_ID)[0] });
      }
    }

    const arrays = new Map<string, Map<number, BinArray | null>>();
    for (let i = 0; i < wanted.length; i += 100) {
      const chunk = wanted.slice(i, i + 100);
      const infos = await this.connection.getMultipleAccountsInfo(chunk.map((w) => w.key));
      infos.forEach((info, idx) => {
        const { address, index } = chunk[idx];
        if (!arrays.has(address)) arrays.set(address, new Map());
        let decoded: BinArray | null = null;
        if (info) {
          try {
            decoded = decodeAccount<BinArray>(this.program, "binArray", info.data);
          } catch {
            decoded = null;
          }
        }
        arrays.get(address)!.set(index, decoded);
      });
    }

    const now = Date.now();
    const out: Record<string, string> = {};
    for (const pool of pools) {
      const pair = pairs.get(pool.address);
      const byIndex = arrays.get(pool.address);
      if (!pair || !byIndex) continue;
      const step = 1 + pair.binStep / 10_000;
      const dx = pool.token_x.decimals;
      const dy = pool.token_y.decimals;
      const center = binIdToBinArrayIndex(new BN(pair.activeId)).toNumber();
      const bins: [number, number][] = [];
      const initialized: number[] = [];
      for (const [index, arr] of byIndex) {
        if (!arr) continue;
        initialized.push(index);
        arr.bins.forEach((bin, pos) => {
          const x = amount(bin.amountX);
          const y = amount(bin.amountY);
          if (x === 0 && y === 0) return;
          const id = index * BINS_PER_ARRAY + pos;
          const price = Math.pow(step, id) * Math.pow(10, dx - dy);
          const value = (x / 10 ** dx) * price + y / 10 ** dy;
          if (Number.isFinite(value) && value > 0) bins.push([id - pair.activeId, Number(value.toPrecision(6))]);
        });
      }
      bins.sort((a, b) => a[0] - b[0]);
      const depth: BinDepth = {
        ts: now,
        active_id: pair.activeId,
        bin_step: pair.binStep,
        array_lo: center - span,
        array_hi: center + span,
        initialized: initialized.sort((a, b) => a - b),
        bins,
      };
      out[pool.address] = JSON.stringify(depth);
    }

    if (Object.keys(out).length > 0) {
      const tmp = `${BINS_LATEST_KEY}:tmp`;
      await redis.multi().del(tmp).hset(tmp, out).rename(tmp, BINS_LATEST_KEY).exec();
    }
    this.lastCount = Object.keys(out).length;
  }
}
