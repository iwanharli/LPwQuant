/**
 * Where a wallet's SOL came from and where it went, read from its own transaction history.
 *
 * - funders: SOL sent to the wallet in its earliest transactions (who paid to set it up);
 * - sent_to / received_from: SOL counterparties over its most recent transactions, summed per wallet;
 * - busy: counterparties with a very long history (exchanges, bots, routers), so a shared exchange deposit
 *   address is not read as two wallets being run by the same person.
 */
import type { Connection, ParsedInstruction, ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

const MAX_SIGNATURES = 3000;
const EARLIEST_TX = 12;
const RECENT_TX = 80;
const MIN_SOL = 0.01;
const TOP = 10;
const BUSY_TXS = 1000;

type Flow = { wallet: string; sol: number; n: number; first_at: number | null; last_at: number | null; busy?: boolean };
type Funder = { wallet: string; sol: number; at: number | null; signature: string; busy?: boolean };

export type WalletTrace = {
  wallet: string;
  tx_count: number;
  tx_count_capped: boolean;
  first_at: number | null;
  last_at: number | null;
  sol_balance: number | null;
  funders: Funder[];
  sent_to: Flow[];
  received_from: Flow[];
  scanned: { earliest: number; recent: number };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(1500 * 2 ** i);
    }
  }
  throw last;
}

/** System-program SOL transfers in a transaction, inner instructions included: [from, to, sol]. */
function transfers(tx: ParsedTransactionWithMeta | null): [string, string, number][] {
  if (!tx || tx.meta?.err) return [];
  const all: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  const out: [string, string, number][] = [];
  for (const ix of all) {
    if (!("parsed" in ix) || ix.program !== "system") continue;
    const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
    if (p.type === "transfer" || p.type === "transferWithSeed") {
      const i = p.info ?? {};
      out.push([String(i.source), String(i.destination), Number(i.lamports ?? 0) / 1e9]);
    } else if (p.type === "createAccount") {
      const i = p.info ?? {};
      out.push([String(i.source), String(i.newAccount), Number(i.lamports ?? 0) / 1e9]);
    }
  }
  return out;
}

async function parsed(conn: Connection, sigs: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
  const out: (ParsedTransactionWithMeta | null)[] = [];
  for (const s of sigs) {
    out.push(await retry(() => conn.getParsedTransaction(s, { maxSupportedTransactionVersion: 0 })).catch(() => null));
    await sleep(120);
  }
  return out;
}

async function isBusy(conn: Connection, wallet: string): Promise<boolean> {
  const page = await retry(() => conn.getSignaturesForAddress(new PublicKey(wallet), { limit: BUSY_TXS })).catch(() => []);
  if (page.length < BUSY_TXS) return false;
  // A thousand transactions inside a week is a service, not a person.
  const span = (page[0].blockTime ?? 0) - (page[page.length - 1].blockTime ?? 0);
  return span < 7 * 86400;
}

export async function traceWallet(conn: Connection, wallet: string): Promise<WalletTrace> {
  const key = new PublicKey(wallet);
  const sigs: { signature: string; blockTime?: number | null; err: unknown }[] = [];
  let before: string | undefined;
  while (sigs.length < MAX_SIGNATURES) {
    const page = await retry(() => conn.getSignaturesForAddress(key, { limit: 1000, before }));
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const ok = sigs.filter((s) => !s.err);
  const capped = sigs.length >= MAX_SIGNATURES;
  const earliest = capped ? [] : ok.slice(-EARLIEST_TX).reverse();
  const recent = ok.slice(0, RECENT_TX);

  const funders: Funder[] = [];
  const earlyTxs = await parsed(conn, earliest.map((s) => s.signature));
  earlyTxs.forEach((tx, i) => {
    for (const [from, to, sol] of transfers(tx)) {
      if (to === wallet && from !== wallet && sol >= MIN_SOL) {
        funders.push({ wallet: from, sol, at: earliest[i].blockTime ? earliest[i].blockTime! * 1000 : null, signature: earliest[i].signature });
      }
    }
  });

  const sent = new Map<string, Flow>();
  const got = new Map<string, Flow>();
  const add = (m: Map<string, Flow>, w: string, sol: number, at: number | null) => {
    const f = m.get(w) ?? { wallet: w, sol: 0, n: 0, first_at: at, last_at: at };
    f.sol += sol;
    f.n += 1;
    if (at != null) {
      f.first_at = Math.min(f.first_at ?? at, at);
      f.last_at = Math.max(f.last_at ?? at, at);
    }
    m.set(w, f);
  };
  const recentTxs = await parsed(conn, recent.map((s) => s.signature));
  recentTxs.forEach((tx, i) => {
    const at = recent[i].blockTime ? recent[i].blockTime! * 1000 : null;
    for (const [from, to, sol] of transfers(tx)) {
      if (sol < MIN_SOL || from === to) continue;
      if (from === wallet) add(sent, to, sol, at);
      else if (to === wallet) add(got, from, sol, at);
    }
  });
  const top = (m: Map<string, Flow>) => [...m.values()].sort((a, b) => b.sol - a.sol).slice(0, TOP);
  const sentTo = top(sent);
  const receivedFrom = top(got);

  const busy = new Map<string, boolean>();
  for (const w of new Set([...funders.map((f) => f.wallet), ...sentTo.map((f) => f.wallet), ...receivedFrom.map((f) => f.wallet)])) {
    busy.set(w, await isBusy(conn, w));
    await sleep(150);
  }
  for (const f of [...funders, ...sentTo, ...receivedFrom]) f.busy = busy.get(f.wallet) ?? false;

  const balance = await conn.getBalance(key).then((l) => l / 1e9).catch(() => null);
  const times = ok.map((s) => s.blockTime).filter((t): t is number => t != null);
  return {
    wallet,
    tx_count: sigs.length,
    tx_count_capped: capped,
    first_at: times.length && !capped ? Math.min(...times) * 1000 : null,
    last_at: times.length ? Math.max(...times) * 1000 : null,
    sol_balance: balance,
    funders,
    sent_to: sentTo,
    received_from: receivedFrom,
    scanned: { earliest: earliest.length, recent: recent.length },
  };
}
