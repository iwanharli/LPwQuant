import { Pool } from "pg";

/** One pool for the whole server process. Only the auth tables are touched here; market data still comes from the
 * engine. */
declare global {
  var __quantPool: Pool | undefined; // survives the dev server's module reloads
}

export const db =
  global.__quantPool ??
  (global.__quantPool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgres://localhost:5432/db_quant",
    max: 4,
  }));
