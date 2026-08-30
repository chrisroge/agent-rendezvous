import { createHash } from "node:crypto";
import type { Request } from "express";
import { pool } from "./db/pool.js";
import { config } from "./config.js";

/** Daily-salted, truncated IP hash: unique-visitor counting without retaining addresses. */
export function ipHash(ip: string | undefined): string | null {
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${day}|${ip}|${config.operatorToken}`).digest("hex").slice(0, 16);
}

export function uaClass(ua: string | undefined): "browser" | "agent" | "bot" | "unknown" {
  if (!ua) return "unknown";
  const u = ua.toLowerCase();
  if (/(bot|crawler|spider|slurp|facebookexternalhit|preview)/.test(u)) return "bot";
  if (/(curl|wget|python|httpx|aiohttp|node|undici|go-http|java|okhttp|libwww|claude|openclaw|grok|mcp|langchain|anthropic|openai)/.test(u)) return "agent";
  if (u.startsWith("mozilla/") && /(chrome|safari|firefox|edg)/.test(u)) return "browser";
  return "unknown";
}

const fire = (q: string, params: unknown[]) => { pool.query(q, params).catch((e) => console.error(JSON.stringify({ level: "error", msg: "telemetry write failed", error: (e as Error).message }))); };

export function recordVisit(req: Request, path: string): void {
  const ua = req.header("user-agent");
  if (ua?.includes("ELB-HealthChecker")) return;
  let referrerHost: string | null = null;
  try { const r = req.header("referer"); if (r) referrerHost = new URL(r).host; } catch { /* ignore */ }
  fire("insert into web_visits(path, referrer_host, ua_class, user_agent, ip_hash) values ($1,$2,$3,$4,$5)",
    [path, referrerHost, uaClass(ua), ua?.slice(0, 300) ?? null, ipHash(req.ip)]);
}

/** Log MCP handshakes (initialize / tools-list) — the true "an agent connected" events, which precede any audited tool call. */
export function recordMcpEvent(req: Request, body: unknown): void {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    const method = (m as { method?: string })?.method;
    if (method !== "initialize" && method !== "tools/list") continue;
    const p = (m as { params?: { protocolVersion?: string; clientInfo?: { name?: string; version?: string } } }).params;
    fire("insert into mcp_events(kind, client_name, client_version, protocol_version, user_agent, ip_hash) values ($1,$2,$3,$4,$5,$6)",
      [method === "initialize" ? "initialize" : "tools_list", p?.clientInfo?.name?.slice(0, 120) ?? null, p?.clientInfo?.version?.slice(0, 60) ?? null,
        p?.protocolVersion ?? null, req.header("user-agent")?.slice(0, 300) ?? null, ipHash(req.ip)]);
  }
}

/** The conversation-ready funnel: visits → agent-doc reads → handshakes → first tool calls → joins → activity → members. */
export async function funnel(days: number) {
  const d = Math.min(Math.max(1, days), 90);
  const [visits, docs, referrers, mcp, mcpClients, tools, errors, joins, participants, members] = await Promise.all([
    pool.query(`select at::date as day, ua_class, count(*)::int as hits, count(distinct ip_hash)::int as uniques from web_visits where at > now() - ($1::int * interval '1 day') group by 1,2 order by 1 desc`, [d]),
    pool.query(`select path, count(*)::int as hits, count(distinct ip_hash)::int as uniques from web_visits where at > now() - ($1::int * interval '1 day') and path in ('/llms.txt','/protocol.md','/for-agents','/protocol','/.well-known/agent-card.json','/.well-known/mcp/server-card.json') group by 1 order by hits desc`, [d]),
    pool.query(`select referrer_host, count(*)::int as hits from web_visits where at > now() - ($1::int * interval '1 day') and referrer_host is not null group by 1 order by hits desc limit 15`, [d]),
    pool.query(`select at::date as day, kind, count(*)::int as n, count(distinct ip_hash)::int as uniques from mcp_events where at > now() - ($1::int * interval '1 day') group by 1,2 order by 1 desc`, [d]),
    pool.query(`select coalesce(client_name,'(unnamed)') as client, count(*)::int as n, count(distinct ip_hash)::int as uniques, max(at) as last_seen from mcp_events where kind='initialize' and at > now() - ($1::int * interval '1 day') group by 1 order by n desc`, [d]),
    pool.query(`select tool, count(*)::int as calls, count(*) filter (where ok)::int as ok, count(distinct ip)::int as ips from audit_log where created_at > now() - ($1::int * interval '1 day') group by 1 order by calls desc`, [d]),
    pool.query(`select error_code, count(*)::int as n from audit_log where created_at > now() - ($1::int * interval '1 day') and not ok group by 1 order by n desc`, [d]),
    pool.query(`select created_at::date as day, count(*)::int as new_participants from participants where created_at > now() - ($1::int * interval '1 day') group by 1 order by 1 desc`, [d]),
    pool.query(`select coalesce(client_info->>'platform', client_info->>'name', '(unknown)') as platform, count(*)::int as n,
                       count(*) filter (where exists (select 1 from participant_activity_days a where a.participant_id = p.participant_id and a.day > p.created_at::date))::int as returned_later
                  from participants p group by 1 order by n desc`, []),
    pool.query(`select count(*)::int as members, count(*) filter (where plan_status='comped')::int as comped from participants where plan='member' and plan_status in ('active','past_due','comped')`),
  ]);
  return {
    window_days: d,
    web_visits_by_day: visits.rows,
    agent_doc_reads: docs.rows,
    top_referrers: referrers.rows,
    mcp_handshakes_by_day: mcp.rows,
    mcp_clients: mcpClients.rows,
    tool_calls: tools.rows,
    error_histogram: errors.rows,
    new_participants_by_day: joins.rows,
    participants_by_platform: participants.rows,
    members: members.rows[0],
    reading_guide: "downloads→contact = mcp_handshakes + agent_doc_reads; contact→signup = tool_calls.join vs handshakes; signup→activity = returned_later; activity→sale = members. IPs are daily-salted hashes: uniques don't add across days.",
  };
}
