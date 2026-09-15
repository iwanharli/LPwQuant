import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { config } from "./config";
import type { PoolSnapshot } from "./meteora";
import type { UsageRow } from "./rpc";
import type { PriceTick } from "./watcher";

export const pg = new Pool({ connectionString: config.databaseUrl, max: 5 });

export async function applySchema(): Promise<void> {
  await pg.query(await readFile(config.schemaPath, "utf8"));
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

export async function savePools(input: PoolSnapshot[]): Promise<void> {
  // One upsert cannot touch the same row twice; paginated scans can return a pool on two pages.
  const pools = [...new Map(input.map((p) => [p.address, p])).values()];
  if (pools.length === 0) return;

  const poolRows = pools.map((p) => ({
    address: p.address,
    name: p.name,
    mint_x: p.token_x.mint,
    mint_y: p.token_y.mint,
    symbol_x: p.token_x.symbol,
    symbol_y: p.token_y.symbol,
    decimals_x: p.token_x.decimals,
    decimals_y: p.token_y.decimals,
    bin_step: p.bin_step,
    base_fee_pct: p.base_fee_pct,
    pool_created_at: iso(p.pool_created_at),
  }));

  const snapshotRows = pools.map((p) => ({
    ts: iso(p.ts),
    address: p.address,
    price: p.price,
    tvl: p.tvl,
    volume_1h: p.volume["1h"],
    volume_24h: p.volume["24h"],
    fees_1h: p.fees["1h"],
    fees_24h: p.fees["24h"],
    fee_tvl_pct_24h: p.fee_tvl_pct["24h"],
    dynamic_fee_pct: p.dynamic_fee_pct,
    token_x: p.token_x,
    token_y: p.token_y,
  }));

  const client = await pg.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into pools (address, name, mint_x, mint_y, symbol_x, symbol_y, decimals_x, decimals_y,
                          bin_step, base_fee_pct, pool_created_at, updated_at)
       select address, name, mint_x, mint_y, symbol_x, symbol_y, decimals_x, decimals_y,
              bin_step, base_fee_pct, pool_created_at, now()
       from jsonb_to_recordset($1::jsonb) as r(
         address text, name text, mint_x text, mint_y text, symbol_x text, symbol_y text,
         decimals_x int, decimals_y int, bin_step int, base_fee_pct float8, pool_created_at timestamptz)
       on conflict (address) do update set
         name = excluded.name,
         symbol_x = excluded.symbol_x,
         symbol_y = excluded.symbol_y,
         base_fee_pct = excluded.base_fee_pct,
         updated_at = now()`,
      [JSON.stringify(poolRows)],
    );
    await client.query(
      `insert into pool_snapshots (ts, address, price, tvl, volume_1h, volume_24h, fees_1h, fees_24h,
                                   fee_tvl_pct_24h, dynamic_fee_pct, token_x, token_y)
       select * from jsonb_to_recordset($1::jsonb) as r(
         ts timestamptz, address text, price float8, tvl float8, volume_1h float8, volume_24h float8,
         fees_1h float8, fees_24h float8, fee_tvl_pct_24h float8, dynamic_fee_pct float8,
         token_x jsonb, token_y jsonb)`,
      [JSON.stringify(snapshotRows)],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function saveTicks(ticks: PriceTick[]): Promise<void> {
  if (ticks.length === 0) return;
  const rows = ticks.map((t) => ({ ...t, ts: iso(t.ts) }));
  await pg.query(
    `insert into price_ticks (ts, address, slot, active_id, price)
     select ts, address, slot, active_id, price
     from jsonb_to_recordset($1::jsonb) as r(ts timestamptz, address text, slot bigint, active_id int, price float8)`,
    [JSON.stringify(rows)],
  );
}

/** `since` is when these counts started accumulating (previous flush), used as bucket first_at. */
export async function saveUsage(rows: UsageRow[], since: number): Promise<void> {
  if (rows.length === 0) return;
  await pg.query(
    `insert into rpc_usage (hour, provider, kind, method, count, first_at)
     select date_trunc('hour', now()), provider, kind, method, count,
            greatest(to_timestamp($2::float8 / 1000), date_trunc('hour', now()))
     from jsonb_to_recordset($1::jsonb) as r(provider text, kind text, method text, count bigint)
     on conflict (hour, provider, kind, method) do update set count = rpc_usage.count + excluded.count`,
    [JSON.stringify(rows), since],
  );
}

export async function pruneOld(): Promise<void> {
  const hours = config.retentionHours;
  for (const table of ["pool_snapshots", "price_ticks", "pool_metrics", "pool_flow"]) {
    await pg.query(`delete from ${table} where ts < now() - make_interval(hours => $1)`, [hours]);
  }
  await pg.query(`delete from rpc_usage where hour < now() - interval '40 days'`);
  await pg.query(`delete from candles where ts < now() - interval '30 days'`);
  await pg.query(`delete from token_insight_snapshots where ts < now() - interval '30 days'`);
}
