import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./pool.js";

/** Apply db/migrations/*.sql in lexical order, once each, under an advisory lock. */
export async function migrate(dir = join(process.cwd(), "db", "migrations")): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(7431)");
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values ($1)", [f]);
        await client.query("commit");
        applied.push(f);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(7431)").catch(() => {});
    client.release();
  }
  return applied;
}

// Allow `npm run migrate` as a standalone command.
if (process.argv[1] && process.argv[1].endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js")) {
  migrate()
    .then((a) => { console.log(JSON.stringify({ msg: "migrations applied", applied: a })); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
