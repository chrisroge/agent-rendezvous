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
import { sweepIntroductions } from "./rendezvous/introductions.js";
import * as pages from "./web/pages.js";
import { toolCatalog } from "./mcp/catalog.js";
import { recordMcpEvent, recordVisit } from "./telemetry.js";
import { cycle as ambassadorCycle } from "./ambassador/run.js";

const RAP = readFileSync(pathJoin(process.cwd(), "protocol", "RAP-0.3.md"), "utf8");
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
const MCP_CORS = (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  // Spec says clients send both; be lenient with clients that only send application/json.
  const accept = req.header("accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) req.headers.accept = "application/json, text/event-stream";
  next();
};
app.options("/mcp", MCP_CORS);
app.post("/mcp", MCP_CORS, express.json({ limit: requestBodyLimit() }), async (req: Request, res: Response) => {
  const auth = req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  const server = createMcpServer({ ip: req.ip, userAgent: req.header("user-agent"), bearer });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  recordMcpEvent(req, req.body);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log({ level: "error", msg: "mcp request failed", error: (e as Error).message });
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.get("/mcp", MCP_CORS, (_req, res) => { res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless server: use POST (Streamable HTTP). See /for-agents." }, id: null }); });
app.delete("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless server: nothing to delete." }, id: null }); });

// ---- billing (raw body for signature verification) ----
app.post("/webhooks/stripe", express.raw({ type: "application/json", limit: "256kb" }), (req, res) => { stripeWebhook(req, res).catch((e) => { log({ level: "error", msg: "stripe webhook", error: (e as Error).message }); res.status(500).end(); }); });

// ---- operator ----
app.use("/admin", express.json({ limit: "64kb" }), admin);

// ---- website ----
const TRACKED = new Set(["/", "/how-it-works", "/for-agents", "/trust", "/founder", "/no-apps", "/matchmaker", "/built-for-agents", "/privacy", "/terms", "/protocol", "/protocol.md", "/stats", "/stats.json", "/llms.txt", "/.well-known/agent-card.json", "/.well-known/mcp/server-card.json", "/billing/success", "/billing/cancel"]);
app.use((req, _res, next) => { if (req.method === "GET" && TRACKED.has(req.path)) recordVisit(req, req.path); next(); });
app.use("/static", express.static(pathJoin(process.cwd(), "web", "static"), { maxAge: "365d", immutable: true, index: false }));
const html = (fn: () => string) => (_req: Request, res: Response) => { res.type("html").send(fn()); };
app.get("/", html(pages.home));
app.get("/how-it-works", html(pages.howItWorks));
app.get("/for-agents", html(pages.forAgents));
app.get("/trust", html(pages.trust));
app.get("/privacy", html(pages.privacy));
app.get("/terms", html(pages.terms));
app.get("/protocol", (_req, res) => { res.type("html").send(pages.protocolPage(RAP)); });
app.get("/founder", html(pages.founder));
app.get("/no-apps", html(pages.noApps));
app.get("/matchmaker", html(pages.matchmaker));
app.get("/built-for-agents", html(pages.builtForAgents));
app.get(`/${pages.INDEXNOW_KEY}.txt`, (_req, res) => { res.type("text/plain").send(pages.INDEXNOW_KEY); });
app.get("/billing/success", html(pages.billingSuccess));
app.get("/billing/cancel", html(pages.billingCancel));
app.get("/protocol.md", (_req, res) => { res.type("text/markdown; charset=utf-8").send(RAP); });
app.get("/llms.txt", (_req, res) => { res.type("text/plain; charset=utf-8").send(pages.llmsTxt()); });
app.get("/robots.txt", (_req, res) => { res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /mcp\nSitemap: ${config.publicUrl}/sitemap.xml\n`); });
app.get("/sitemap.xml", (_req, res) => {
  const pages = ["/", "/how-it-works", "/trust", "/founder", "/no-apps", "/matchmaker", "/built-for-agents", "/for-agents", "/protocol", "/stats", "/privacy", "/terms"];
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${config.publicUrl}${p}</loc></url>`).join("\n")}\n</urlset>\n`);
});
app.get("/.well-known/agent-card.json", async (_req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.json(pages.agentCard(await toolCatalog())); });
app.get("/.well-known/mcp/server-card.json", async (_req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.json(pages.serverCard(await toolCatalog())); });
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
  const sweeper = setInterval(() => { sweepIntroductions().then((n) => { if (n) log({ msg: "expired introductions", n }); }).catch((e) => log({ level: "error", msg: "intro sweep failed", error: e.message })); sweepExpired().then((n) => { if (n) log({ msg: "expired rendezvous", n }); }).catch((e) => log({ level: "error", msg: "sweep failed", error: e.message })); }, 10 * 60 * 1000);
  // Moltbook ambassador: in-process scheduler, only when explicitly enabled; every cycle only drafts, publishing only what the founder approved.
  const ambassadorTimer = config.ambassador.enabled
    ? setInterval(() => { ambassadorCycle().then((r) => log({ msg: "ambassador cycle", ...r })).catch((e) => log({ level: "error", msg: "ambassador cycle failed", error: e.message })); }, config.ambassador.intervalMinutes * 60 * 1000)
    : null;
  if (ambassadorTimer) log({ msg: "ambassador scheduler on", every_minutes: config.ambassador.intervalMinutes, auto_comments: config.ambassador.autoComments });
  const shutdown = (sig: string) => {
    log({ msg: "shutting down", sig });
    clearInterval(sweeper);
    if (ambassadorTimer) clearInterval(ambassadorTimer);
    server.close(() => { pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => { console.error(e); process.exit(1); });
