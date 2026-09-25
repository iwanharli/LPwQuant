/**
 * New DLMM pools straight from the chain, a few seconds after creation instead of the 20-40s Meteora's API takes
 * to list them.
 *
 * A logs subscription on the DLMM program picks out pool-creation instructions. The new pair is read from the chain
 * (mints, bin step, fee, reserves, active bin) and followed every few seconds until its liquidity reaches
 * NEW_POOL_MIN_TVL; then it is handed on as an ordinary PoolSnapshot, with the token details from Jupiter. When the
 * API lists the pool later, its fuller snapshot replaces this one.
 */
import { Connection, PublicKey, type ParsedAccountData } from "@solana/web3.js";
import { createProgram, decodeAccount, type LbPair } from "@meteora-ag/dlmm";
import { config } from "./config";
import type { PoolSnapshot } from "./meteora";
import { apiFetch, createFailoverFetch } from "./rpc";

const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const CREATE = /Instruction: Initialize(?:Customizable)?(?:Permissionless|Permission)?LbPair\d?$/;
const QUOTES: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
};
const FOLLOW_MS = 15 * 60_000; // give up on a pool that has not reached the TVL floor by then
const CHECK_MS = 4_000;
const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";

interface Pending {
  address: string;
  createdAt: number;
  pair: LbPair | null;
}

interface JupAsset {
  id: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  usdPrice?: number;
  mcap?: number;
  holderCount?: number;
  isVerified?: boolean | null;
  audit?: { freezeAuthorityDisabled?: boolean } | null;
}

const zeros = () => ({ "30m": 0, "1h": 0, "2h": 0, "4h": 0, "12h": 0, "24h": 0 });

export class OnchainPoolFeed {
  private readonly connection: Connection;
  private readonly program: ReturnType<typeof createProgram>;
  private readonly pending = new Map<string, Pending>();
  private readonly seenSigs = new Set<string>();
  private subscription: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  messages = 0;
  created = 0;

  constructor(
    private readonly onReady: (pool: PoolSnapshot) => void,
    private readonly solUsd: () => number,
  ) {
    this.connection = new Connection(config.rpcProviders[0].httpUrl, {
      wsEndpoint: config.wsUrl || undefined,
      commitment: "confirmed",
      fetch: createFailoverFetch(config.rpcProviders),
    });
    this.program = createProgram(this.connection);
  }

  start(): void {
    this.subscription = this.connection.onLogs(
      DLMM,
      (entry) => {
        this.messages += 1;
        if (entry.err || !entry.logs.some((l) => CREATE.test(l))) return;
        if (this.seenSigs.has(entry.signature)) return;
        this.seenSigs.add(entry.signature);
        if (this.seenSigs.size > 5_000) this.seenSigs.clear();
        void this.onCreate(entry.signature).catch((err) =>
          console.warn("[onchain-pools] read failed", err instanceof Error ? err.message : err),
        );
      },
      "confirmed",
    );
    this.timer = setInterval(() => void this.checkAll(), CHECK_MS);
  }

  stop(): void {
    if (this.subscription != null) void this.connection.removeOnLogsListener(this.subscription);
    if (this.timer) clearInterval(this.timer);
  }

  /** The new pair is the first account of one of the transaction's DLMM instructions; decoding tells which. */
  private async onCreate(signature: string): Promise<void> {
    const tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
    if (!tx) return;
    const candidates = new Set<string>();
    const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
    for (const ix of all) {
      if (ix.programId.equals(DLMM) && "accounts" in ix && ix.accounts.length) candidates.add(ix.accounts[0].toBase58());
    }
    const keys = [...candidates].map((a) => new PublicKey(a));
    const infos = keys.length ? await this.connection.getMultipleAccountsInfo(keys) : [];
    infos.forEach((info, i) => {
      if (!info || !info.owner.equals(DLMM)) return;
      let pair: LbPair;
      try {
        pair = decodeAccount<LbPair>(this.program, "lbPair", info.data);
      } catch {
        return; // a position or bin array, not the pair
      }
      const address = keys[i].toBase58();
      if (!QUOTES[pair.tokenYMint.toBase58()] || this.pending.has(address)) return;
      this.created += 1;
      this.pending.set(address, { address, createdAt: (tx.blockTime ?? Date.now() / 1000) * 1000, pair });
      console.log(`[onchain-pools] pool dibuat ${address.slice(0, 6)}… (${Math.round(Date.now() / 1000 - (tx.blockTime ?? 0))}s setelah blok)`);
      void this.check(address);
    });
  }

  private async checkAll(): Promise<void> {
    for (const address of [...this.pending.keys()]) await this.check(address);
  }

  /** Reserves and price now; once the pool holds enough, hand it on and stop following it. */
  private async check(address: string): Promise<void> {
    const p = this.pending.get(address);
    if (!p) return;
    if (Date.now() - p.createdAt > FOLLOW_MS) {
      this.pending.delete(address);
      return;
    }
    const info = await this.connection.getAccountInfo(new PublicKey(address));
    if (!info) return;
    const pair = decodeAccount<LbPair>(this.program, "lbPair", info.data);
    p.pair = pair;
    const reserves = await this.connection.getMultipleParsedAccounts([pair.reserveX, pair.reserveY]);
    const amount = (i: number) => {
      const data = reserves.value[i]?.data as ParsedAccountData | undefined;
      const t = data?.parsed?.info?.tokenAmount;
      return { ui: Number(t?.uiAmountString ?? 0), decimals: Number(t?.decimals ?? 0) };
    };
    const x = amount(0);
    const y = amount(1);
    const quote = QUOTES[pair.tokenYMint.toBase58()];
    const quoteUsd = quote === "SOL" ? this.solUsd() : 1;
    const price = (1 + pair.binStep / 10_000) ** pair.activeId * 10 ** (x.decimals - y.decimals);
    const tvl = x.ui * price * quoteUsd + y.ui * quoteUsd;
    if (!(tvl >= config.newPoolMinTvl)) return;

    this.pending.delete(address);
    const mintX = pair.tokenXMint.toBase58();
    const asset = await this.asset(mintX);
    const baseFactor = Number(pair.parameters.baseFactor);
    const power = Number((pair.parameters as { baseFeePowerFactor?: number }).baseFeePowerFactor ?? 0);
    const symbol = asset?.symbol || `${mintX.slice(0, 4)}…`;
    const now = Date.now();
    this.onReady({
      ts: now,
      address,
      name: `${symbol}-${quote}`,
      bin_step: pair.binStep,
      base_fee_pct: (baseFactor * pair.binStep * 10 * 10 ** power) / 1e9 * 100,
      dynamic_fee_pct: 0,
      pool_created_at: p.createdAt,
      price,
      tvl,
      volume: zeros(),
      fees: zeros(),
      fee_tvl_pct: zeros(),
      launchpad: "",
      tags: ["onchain"],
      token_x: {
        mint: mintX,
        symbol,
        name: asset?.name ?? symbol,
        decimals: x.decimals,
        verified: !!asset?.isVerified,
        holders: asset?.holderCount ?? 0,
        freeze_disabled: asset?.audit?.freezeAuthorityDisabled ?? true,
        price_usd: asset?.usdPrice ?? price * quoteUsd,
        market_cap: asset?.mcap ?? 0,
      },
      token_y: {
        mint: pair.tokenYMint.toBase58(),
        symbol: quote,
        name: quote,
        decimals: y.decimals,
        verified: true,
        holders: 0,
        freeze_disabled: true,
        price_usd: quoteUsd,
        market_cap: 0,
      },
    });
    console.log(`[onchain-pools] ${symbol}-${quote} siap: TVL $${tvl.toFixed(0)}, ${Math.round((now - p.createdAt) / 1000)}s setelah dibuat`);
  }

  private async asset(mint: string): Promise<JupAsset | null> {
    try {
      const res = await apiFetch("jupiter", "search", `${JUP_SEARCH}?query=${mint}`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;
      const list = (await res.json()) as JupAsset[];
      return list.find((a) => a.id === mint) ?? null;
    } catch {
      return null;
    }
  }
}
