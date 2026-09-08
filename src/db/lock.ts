import { pool } from './pool.js';
/** Session lock spans asynchronous work without holding a database transaction open. */
export async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T | null> {
  const c = await pool.connect();
  let acquired = false;
  try {
    acquired = (await c.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [key])).rows[0].locked;
    return acquired ? await work() : null;
  } finally {
    if (acquired) await c.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => {});
    c.release();
  }
}
