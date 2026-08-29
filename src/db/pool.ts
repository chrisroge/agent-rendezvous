import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ ...config.db, max: 8, idleTimeoutMillis: 30_000 });

pool.on("error", (err) => {
  console.error(JSON.stringify({ level: "error", msg: "pg pool error", error: err.message }));
});

export type Queryable = pg.Pool | pg.PoolClient;

/** Run fn inside a transaction; rolls back on throw. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
