import pg from "pg";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/** June's own database on the shared RDS instance. Bootstraps `CREATE DATABASE june` on first run. */
const JUNE_DB = (process.env.JUNE_DB_NAME ?? "june").replace(/[^a-z0-9_]/g, "");

/** pg config targeting a specific database, whether the base uses discrete params or a connection string. */
function forDb(database: string): pg.PoolConfig {
  const b = { ...config.db } as pg.PoolConfig & { connectionString?: string };
  if (b.connectionString) { const u = new URL(b.connectionString); u.pathname = "/" + database; return { connectionString: u.toString(), ssl: b.ssl }; }
  return { ...b, database };
}

export const junePool = new pg.Pool({ ...forDb(JUNE_DB), max: 6 });
junePool.on("error", (e) => console.error(JSON.stringify({ level: "error", component: "june", msg: "pg pool error", error: e.message })));

export async function juneMigrate(): Promise<string[]> {
  // Bootstrap the database if missing (master user has CREATEDB on RDS).
  // Connect to the default 'postgres' database to check/create June's database.
  const admin = new pg.Pool({ ...forDb("postgres"), max: 1 });
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [JUNE_DB]);
    if (!exists.rowCount) await admin.query(`create database ${JUNE_DB}`);
  } finally { await admin.end(); }
  const dir = join(process.cwd(), "db", "june-migrations");
  if (!existsSync(dir)) return [];
  const applied: string[] = [];
  const c = await junePool.connect();
  try {
    await c.query("select pg_advisory_lock(7432)");
    await c.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())");
    const done = new Set((await c.query("select name from schema_migrations")).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      await c.query("begin");
      try { await c.query(readFileSync(join(dir, f), "utf8")); await c.query("insert into schema_migrations(name) values ($1)", [f]); await c.query("commit"); applied.push(f); }
      catch (e) { await c.query("rollback"); throw new Error(`june migration ${f}: ${(e as Error).message}`); }
    }
  } finally { await c.query("select pg_advisory_unlock(7432)").catch(() => {}); c.release(); }
  return applied;
}
