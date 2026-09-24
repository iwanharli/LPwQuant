/**
 * Auto close + sell for the bot wallet: the one place in this app that signs without a wallet prompt.
 *
 * Only positions the user armed on the dashboard (table auto_close) and owned by the bot wallet whose secret key is
 * BOT_WALLET_SECRET in .env. The key is read once, never logged, and used for nothing else. Every CHECK_MS:
 *   1. quick estimate from the chain: position amounts at the pool's active price, less what was put in (basis from
 *      Meteora: deposits minus fees and withdrawals already taken out). No swap cost yet.
 *   2. when the estimate reaches the target, the real exit: the close is built and simulated and Jupiter quotes the
 *      sale of the token part. Net = SOL/USDC received + the sale's output - basis. Only if that still reaches the
 *      target is anything signed: the close first, then, once it has landed, the sale of exactly what it brought in.
 */
import { utils } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { buildClose, buildSell, poolFor, rpc, serial, tokenInfo } from "./claim-server";
import { config } from "./config";
import { pg } from "./db";

const CHECK_MS = 10_000;
const BASIS_REFRESH_MS = 60_000;
const MAX_EXIT_COST_PCT = 5; // Jupiter's price impact + fees: above this the sale is refused and retried later
const SELL_TRIES = 3;
const SOL_MINT = "So11111111111111111111111111111111111111112";

type Armed = { position: string; pool: string; owner: string; target_pct: number };

let bot: Keypair | null = null;
export function botWallet(): Keypair | null {
  if (bot) return bot;
  const secret = process.env.BOT_WALLET_SECRET?.trim();
  if (!secret) return null;
  try {
    bot = secret.startsWith("[")
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]))
      : Keypair.fromSecretKey(utils.bytes.bs58.decode(secret));
  } catch {
    console.warn("[auto-close] BOT_WALLET_SECRET could not be read; auto close stays off");
    return null;
  }
  return bot;
}

async function telegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

const basis = new Map<string, { at: number; usd: number }>();
/** What the position still has to earn back, from Meteora's own figures: value + unclaimed fees - PnL. */
async function basisUsd(owner: string, position: string): Promise<number | null> {
  const hit = basis.get(position);
  if (hit && Date.now() - hit.at < BASIS_REFRESH_MS) return hit.usd;
  const res = await fetch(`${config.engineUrl}/api/portfolio?wallet=${owner}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return hit?.usd ?? null;
  const body = (await res.json()) as {
    pools: { positions: { address: string; value_usd: number; unclaimed_fees_usd: number; pnl_usd: number }[] }[];
  };
  for (const pool of body.pools ?? []) {
    for (const p of pool.positions ?? []) {
      basis.set(p.address, { at: Date.now(), usd: p.value_usd + p.unclaimed_fees_usd - p.pnl_usd });
    }
  }
  return basis.get(position)?.usd ?? null;
}

/** Position value in USD now, from the chain: amounts plus unclaimed fees at the pool's active price. */
async function valueNow(a: Armed): Promise<number | null> {
  return serial(async () => {
    const dlmm = await poolFor(a.pool);
    const [{ positionData: d }, active] = await Promise.all([
      dlmm.getPosition(new PublicKey(a.position)),
      dlmm.getActiveBin(),
    ]);
    const x = (Number(d.totalXAmount) + Number(d.feeX.toString())) / 10 ** dlmm.tokenX.mint.decimals;
    const y = (Number(d.totalYAmount) + Number(d.feeY.toString())) / 10 ** dlmm.tokenY.mint.decimals;
    const priceXinY = Number(active.pricePerToken);
    const yMint = dlmm.tokenY.publicKey.toBase58();
    const yUsd = (await tokenInfo([yMint]))[yMint]?.price;
    return yUsd ? (x * priceXinY + y) * yUsd : null;
  });
}

async function update(position: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  await pg.query(
    `update auto_close set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where position = $1`,
    [position, ...keys.map((k) => fields[k])],
  );
}

async function execute(a: Armed, kp: Keypair, basisValue: number) {
  const conn = rpc();
  const built = await buildClose({ owner: a.owner, pool: a.pool, position: a.position });
  const info = await tokenInfo([built.token_x, built.token_y, SOL_MINT]);
  const px = info[built.token_x]?.price ?? 0;
  const py = info[built.token_y]?.price ?? 0;
  // Received without a sale: the side that is not sold. With a sale: its quoted output in place of the token side.
  const sell = built.sell;
  let out = built.receive_x * px + built.receive_y * py;
  if (sell) {
    if (!sell.quote || sell.quote.cost_pct > MAX_EXIT_COST_PCT) {
      await update(a.position, { error: `biaya jual ${sell.quote ? sell.quote.cost_pct.toFixed(1) + "%" : "tanpa harga"}, ditunda` });
      return;
    }
    out = out - sell.value_usd + sell.quote.out_usd;
  }
  const net = out - basisValue - (built.network_fee_lamports / 1e9) * (info[SOL_MINT]?.price ?? 0);
  const netPct = (net / basisValue) * 100;
  await update(a.position, { last_net_pct: netPct, last_checked_at: new Date() });
  if (netPct < a.target_pct) return; // the estimate was optimistic: the exit swap takes it below the target

  await update(a.position, { status: "closing", result_usd: net, error: null });
  const closeSigs: string[] = [];
  for (const b64 of built.transactions) {
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    tx.partialSign(kp);
    closeSigs.push(await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 }));
  }
  await update(a.position, { close_sigs: closeSigs });
  let sellSig: string | null = null;
  if (sell) {
    for (let attempt = 1; attempt <= SELL_TRIES && !sellSig; attempt++) {
      try {
        const s = await buildSell({ owner: a.owner, mint: sell.mint, output: sell.output, before_raw: sell.before_raw, signatures: closeSigs, slippage_bps: sell.slippage_bps });
        const vtx = VersionedTransaction.deserialize(Buffer.from(s.transaction, "base64"));
        vtx.sign([kp]);
        sellSig = await conn.sendRawTransaction(vtx.serialize(), { maxRetries: 3 });
      } catch (err) {
        await update(a.position, { error: `jual percobaan ${attempt}: ${err instanceof Error ? err.message : err}` });
        if (attempt === SELL_TRIES) throw err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  await update(a.position, { status: "done", sell_sig: sellSig, enabled: false });
  await telegram(
    `✅ <b>Auto close</b>: posisi ditutup di hasil bersih <b>${netPct >= 0 ? "+" : ""}${netPct.toFixed(2)}%</b> (${net >= 0 ? "+" : "−"}$${Math.abs(net).toFixed(2)})` +
      (sell ? `, ${sell.symbol} dijual ke ${sell.output_symbol}` : "") +
      `\n<a href="https://solscan.io/tx/${closeSigs[0]}">tutup</a>` +
      (sellSig ? ` · <a href="https://solscan.io/tx/${sellSig}">jual</a>` : ""),
  );
}

async function checkOne(a: Armed, kp: Keypair) {
  const b = await basisUsd(a.owner, a.position);
  if (b == null || b <= 0) return;
  const v = await valueNow(a);
  if (v == null) return;
  const est = ((v - b) / b) * 100;
  await update(a.position, { basis_usd: b, last_net_pct: est, last_checked_at: new Date() });
  if (est >= a.target_pct) await execute(a, kp, b);
}

let running = false;
export function startAutoClose() {
  const kp = botWallet();
  if (!kp) return null;
  console.log(`[auto-close] on for bot wallet ${kp.publicKey.toBase58().slice(0, 4)}…`);
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await pg.query<Armed>(
        "select position, pool, owner, target_pct from auto_close where enabled and status = 'armed' and owner = $1",
        [kp.publicKey.toBase58()],
      );
      for (const a of rows) {
        try {
          await checkOne(a, kp);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const { rows: st } = await pg.query<{ status: string }>("select status from auto_close where position = $1", [a.position]);
          if (st[0]?.status === "closing") {
            await update(a.position, { status: "failed", enabled: false, error: message });
            await telegram(`⚠️ <b>Auto close gagal</b> di tengah jalan: ${message.slice(0, 300)}\nCek posisi dan wallet bot.`);
          } else {
            await update(a.position, { error: message.slice(0, 500) });
          }
        }
      }
    } finally {
      running = false;
    }
  }, CHECK_MS);
}
