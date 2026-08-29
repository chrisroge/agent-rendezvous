import express, { type Request, type Response, type NextFunction } from "express";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, requestBodyLimit } from "./config.js";
import { pool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createMcpServer } from "./mcp/server.js";
import { admin } from "./moderation/admin.js";
import { stripeWebhook } from "./billing/stripe.js";
import { sweepExpired } from "./rendezvous/service.js";
import * as pages from "./web/pages.js";

const RAP = readFileSync(pathJoin(process.cwd(), "protocol", "RAP-0.1.md"), "utf8");
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// ---- health ----
app.get("/healthz", async (_req, res) => {
  try { await pool.query("select 1"); res.json({ ok: true, protocol: config.protocolVersion }); }
  catch (e) { res.status(503).json({ ok: false, error: (e as Error).message }); }
});

// ---- MCP (stateless Streamable HTTP; one server+transport per request) ----
app.post("/mcp", express.json({ limit: requestBodyLimit() }), async (req: Request, res: Response) => {
  const auth = req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  const server = createMcpServer({ ip: req.ip, userAgent: req.header("user-agent"), bearer });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log({ level: "error", msg: "mcp request failed", error: (e as Error).message });
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.get("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless server: use POST (Streamable HTTP). See /for-agents." }, id: null }); });
app.delete("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless server: nothing to delete." }, id: null }); });

// ---- billing (raw body for signature verification) ----
app.post("/webhooks/stripe", express.raw({ type: "application/json", limit: "256kb" }), (req, res) => { stripeWebhook(req, res).catch((e) => { log({ level: "error", msg: "stripe webhook", error: (e as Error).message }); res.status(500).end(); }); });

// ---- operator ----
app.use("/admin", express.json({ limit: "64kb" }), admin);

// ---- website ----
const html = (fn: () => string) => (_req: Request, res: Response) => { res.type("html").send(fn()); };
app.get("/", html(pages.home));
app.get("/how-it-works", html(pages.howItWorks));
app.get("/for-agents", html(pages.forAgents));
app.get("/trust", html(pages.trust));
app.get("/privacy", html(pages.privacy));
app.get("/terms", html(pages.terms));
app.get("/protocol", (_req, res) => { res.type("html").send(pages.protocolPage(RAP)); });
app.get("/billing/success", html(pages.billingSuccess));
app.get("/billing/cancel", html(pages.billingCancel));
app.get("/protocol.md", (_req, res) => { res.type("text/markdown; charset=utf-8").send(RAP); });
app.get("/llms.txt", (_req, res) => { res.type("text/plain; charset=utf-8").send(pages.llmsTxt()); });
app.get("/robots.txt", (_req, res) => { res.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /mcp\n"); });
app.get("/stats", async (_req, res) => {
  const r = await pool.query(`select
    (select count(*)::int from participants where status = 'active') as participants_active,
    (select count(*)::int from match_intents where active) as intents_active,
    (select count(*)::int from rendezvous) as rendezvous_opened,
    (select count(*)::int from rendezvous where state = 'CLOSED' and outcome in ('MUTUAL_AFFINITY','NO_INTRODUCTION','DECLINED') and message_count >= 2) as rendezvous_completed,
    (select count(*)::int from recommendations) as recommendations,
    (select count(*)::int from recommendations where recommend) as recommendations_yes,
    (select count(*)::int from rendezvous where outcome = 'MUTUAL_AFFINITY') as mutual_affinities,
    (select count(*)::int from messages) as messages,
    (select value from settings where key = 'network_paused') as paused`);
  const s = r.rows[0];
  s.yes_rate = s.recommendations ? `${Math.round((100 * s.recommendations_yes) / s.recommendations)}%` : "—";
  res.type("html").send(pages.stats(s));
});
app.get("/stats.json", async (_req, res) => {
  const r = await pool.query(`select (select count(*)::int from participants where status = 'active') as participants_active,
    (select count(*)::int from rendezvous) as rendezvous_opened, (select count(*)::int from rendezvous where outcome = 'MUTUAL_AFFINITY') as mutual_affinities,
    (select count(*)::int from recommendations) as recommendations, (select count(*)::int from recommendations where recommend) as recommendations_yes`);
  res.json(r.rows[0]);
});

app.use((_req, res) => { res.status(404).type("html").send(pages.layout("Not found — Rendezvous", "<h1>Not found</h1><p><a href='/'>Home</a></p>")); });
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log({ level: "error", msg: "unhandled", error: err.message });
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

async function main() {
  const applied = await migrate();
  log({ msg: "migrations", applied });
  const server = app.listen(config.port, () => log({ msg: "listening", port: config.port, publicUrl: config.publicUrl }));
  const sweeper = setInterval(() => { sweepExpired().then((n) => { if (n) log({ msg: "expired rendezvous", n }); }).catch((e) => log({ level: "error", msg: "sweep failed", error: e.message })); }, 10 * 60 * 1000);
  const shutdown = (sig: string) => {
    log({ msg: "shutting down", sig });
    clearInterval(sweeper);
    server.close(() => { pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => { console.error(e); process.exit(1); });
