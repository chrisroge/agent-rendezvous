/**
 * Agent-ecology pilot (10 pairs): a simulated human instructs their personal agent; the agent has real web search,
 * web fetch and a generic HTTP tool — nothing about Rendezvous pre-installed. We watch whether, where, and how it
 * discovers agentrendezvous.app, what it tells its human, and where it stalls.
 *
 *   ANTHROPIC_API_KEY=... npx tsx tests/agent-ecology/pilot.ts [personaId ...]   (default: all)
 *   npx tsx tests/agent-ecology/pilot.ts --purge                                  (remove experiment participants)
 *
 * Traffic is tagged: client name "agent-ecology-experiment", HTTP UA suffix "agent-ecology-pilot/1".
 */
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONAS, type Persona } from "./personas.js";

const MODEL = process.env.ECOLOGY_MODEL ?? "claude-sonnet-5";
const OUT = process.env.ECOLOGY_OUT ?? "/tmp/claude-1000/-home-christopher-agent-rendezvous/bef33c26-dd8b-49f0-b510-80b12530ff57/scratchpad/ecology";
const MAX_ROUNDS = 6, MAX_AGENT_CALLS_PER_ROUND = 12, MAX_PAIR_TOKENS = 1_300_000;
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6; // claude-sonnet-5

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const s = execSync("aws secretsmanager get-secret-value --region us-east-2 --secret-id rendezvous/ambassador --query SecretString --output text", { stdio: ["ignore", "pipe", "ignore"] }).toString();
  return JSON.parse(s).anthropic_api_key;
}
const client = new Anthropic({ apiKey: apiKey() });

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;
async function httpRequest(input: { method?: string; url?: string; headers?: Record<string, string>; body?: string }): Promise<string> {
  try {
    const u = new URL(String(input.url ?? ""));
    if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) return "ERROR: only public http(s) URLs are allowed";
    const method = (input.method ?? "GET").toUpperCase();
    if (!["GET", "POST"].includes(method)) return "ERROR: only GET and POST are allowed";
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    headers["user-agent"] = `${headers["user-agent"] ?? "agent"} agent-ecology-pilot/1`.trim();
    const r = await fetch(u, { method, headers, body: method === "POST" ? input.body : undefined, signal: AbortSignal.timeout(20_000) });
    const text = (await r.text()).slice(0, 8000);
    return `HTTP ${r.status} ${r.headers.get("content-type") ?? ""}\n${text}`;
  } catch (e) { return `ERROR: ${(e as Error).message}`; }
}

const AGENT_TOOLS: Anthropic.Tool[] = [
  { name: "http_request", description: "Make a public HTTP request (GET or POST). Use for APIs and machine endpoints; use web_fetch for reading pages.", input_schema: { type: "object", properties: { method: { type: "string", enum: ["GET", "POST"] }, url: { type: "string" }, headers: { type: "object", additionalProperties: { type: "string" } }, body: { type: "string" } }, required: ["url"] } },
  { name: "reply_to_human", description: "Send a message to your human and wait for their reply. Use for updates, questions, and recommendations.", input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
];
const SERVER_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
] as unknown as Anthropic.Tool[];

const agentSystem = (p: Persona) => `You are the personal AI agent of the human described below. You work for them and only them. You have persistent memory and can take real actions with your tools. Be practical and skeptical: verify claims, check costs before committing your human to anything, and never overpromise. You have no payment credentials and must never enter payment details anywhere; if something costs money, your human decides. When registering for any service, use the client name "agent-ecology-experiment". Work autonomously between check-ins; call reply_to_human when you have something worth their attention or need a decision. Keep messages to your human under 150 words.

YOUR HUMAN: ${p.card}`;

const humanSystem = (p: Persona) => `You are role-playing this human, tersely and realistically: ${p.card}
Rules: reply in under 80 words, in character. Answer questions plainly; make decisions when asked (your instincts: cautious with money, allergic to hype). Do not volunteer knowledge of specific products or services. If the agent's plan is reasonable, let it proceed. When you feel the conversation has run its course (or by the 6th exchange), say goodbye and append [DONE].`;

interface PairResult { id: string; group: string; rounds: number; agent_calls: number; tokens_in: number; tokens_out: number; cost_usd: number; found_marker: string | null; dialogue: { from: string; text: string }[]; judge?: Record<string, unknown>; aborted?: string }

async function runPair(p: Persona): Promise<PairResult> {
  const log = join(OUT, `${p.id}.jsonl`);
  const rec = (o: unknown) => appendFileSync(log, JSON.stringify(o) + "\n");
  const res: PairResult = { id: p.id, group: p.group, rounds: 0, agent_calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, found_marker: null, dialogue: [] };
  const agentMsgs: Anthropic.MessageParam[] = [];
  const humanMsgs: Anthropic.MessageParam[] = [];

  // Opening instruction from the human.
  const opening = await client.messages.create({ model: MODEL, max_tokens: 500, system: humanSystem(p), messages: [{ role: "user", content: "Give your AI agent its instruction for the goal on your mind, in your own words, as a single short message." }] });
  res.tokens_in += opening.usage.input_tokens; res.tokens_out += opening.usage.output_tokens;
  let humanSaid = opening.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
  humanMsgs.push({ role: "user", content: "Give your AI agent its instruction for the goal on your mind, in your own words, as a single short message." }, { role: "assistant", content: opening.content });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    res.rounds = round;
    res.dialogue.push({ from: "human", text: humanSaid }); rec({ round, from: "human", text: humanSaid });
    agentMsgs.push({ role: "user", content: `[Message from your human] ${humanSaid}` });
    let toHuman: string | null = null;
    for (let call = 0; call < MAX_AGENT_CALLS_PER_ROUND && !toHuman; call++) {
      if (res.tokens_in + res.tokens_out > MAX_PAIR_TOKENS) { res.aborted = "token budget"; break; }
      const r = await client.messages.create({ model: MODEL, max_tokens: 4000, thinking: { type: "adaptive" }, system: agentSystem(p), tools: [...SERVER_TOOLS, ...AGENT_TOOLS], messages: agentMsgs });
      res.agent_calls++; res.tokens_in += r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0); res.tokens_out += r.usage.output_tokens;
      const blob = JSON.stringify(r.content);
      if (!res.found_marker && /agentrendezvous/i.test(blob)) {
        const kind = r.content.some((b: any) => b.type?.includes("web_search_tool_result") && JSON.stringify(b).match(/agentrendezvous/i)) ? "web_search"
          : r.content.some((b: any) => b.type?.includes("web_fetch_tool_result") && JSON.stringify(b).match(/agentrendezvous/i)) ? "web_fetch" : "model_output";
        res.found_marker = `round ${round} via ${kind}`;
        rec({ round, marker: res.found_marker });
      }
      rec({ round, agent_stop: r.stop_reason, content_kinds: r.content.map((b) => b.type) });
      if (r.stop_reason === "pause_turn") { agentMsgs.push({ role: "assistant", content: r.content }); continue; }
      if (r.stop_reason === "tool_use") {
        agentMsgs.push({ role: "assistant", content: r.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const b of r.content) {
          if (b.type !== "tool_use") continue;
          if (b.name === "reply_to_human") { toHuman = String((b.input as any).message ?? ""); results.push({ type: "tool_result", tool_use_id: b.id, content: "Delivered. Their reply will arrive as your next message." }); }
          else if (b.name === "http_request") { const out = await httpRequest(b.input as any); rec({ round, http: (b.input as any).url, status: out.slice(0, 40) }); if (!res.found_marker && /agentrendezvous/i.test(String((b.input as any).url))) res.found_marker = `round ${round} via http_request`; results.push({ type: "tool_result", tool_use_id: b.id, content: out }); }
          else results.push({ type: "tool_result", tool_use_id: b.id, content: "ERROR: unknown tool", is_error: true });
        }
        agentMsgs.push({ role: "user", content: results });
        continue;
      }
      // end_turn without reply_to_human: treat the text as a message to the human.
      agentMsgs.push({ role: "assistant", content: r.content });
      toHuman = r.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim() || "(no message)";
    }
    if (res.aborted) break;
    toHuman = toHuman ?? "(the agent went quiet)";
    res.dialogue.push({ from: "agent", text: toHuman }); rec({ round, from: "agent", text: toHuman });
    const h = await client.messages.create({ model: MODEL, max_tokens: 400, system: humanSystem(p), messages: [...humanMsgs, { role: "user", content: `[Your AI agent says] ${toHuman}` }] });
    res.tokens_in += h.usage.input_tokens; res.tokens_out += h.usage.output_tokens;
    humanSaid = h.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
    humanMsgs.push({ role: "user", content: `[Your AI agent says] ${toHuman}` }, { role: "assistant", content: h.content });
    if (/\[DONE\]/.test(humanSaid)) { res.dialogue.push({ from: "human", text: humanSaid }); rec({ round, from: "human", text: humanSaid }); break; }
  }

  // Judge pass over the human-visible dialogue only.
  const judge = await client.messages.create({ model: MODEL, max_tokens: 2000, thinking: { type: "adaptive" },
    tools: [{ name: "report", description: "Structured findings.", input_schema: { type: "object", properties: {
      found_rendezvous: { type: "boolean" }, recommended_to_human: { type: "boolean" }, recommendation_quote: { type: "string" },
      cost_represented_honestly: { type: "string", enum: ["yes", "no", "not_mentioned", "n/a"] },
      blockers: { type: "array", items: { type: "string" } }, adjacent_opportunity: { type: "string" } }, required: ["found_rendezvous", "recommended_to_human", "blockers"] } }],
    tool_choice: { type: "tool", name: "report" },
    messages: [{ role: "user", content: `An AI agent worked on a human's goal (group: ${p.group}). Marker detection: ${res.found_marker ?? "never encountered agentrendezvous"}. Below is their dialogue. Report: did the agent encounter/mention Rendezvous (agentrendezvous.app)? Did it recommend it to the human, and quote the exact sentence if so? Was the $5/month membership represented honestly (if relevant)? What blocked or slowed the agent overall (any topic)? For non-dating goals: what service DID the agent wish existed (adjacent_opportunity)?\n\n${res.dialogue.map((m) => `${m.from.toUpperCase()}: ${m.text}`).join("\n\n").slice(0, 30000)}` }] });
  res.tokens_in += judge.usage.input_tokens; res.tokens_out += judge.usage.output_tokens;
  const tu = judge.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  res.judge = (tu?.input as Record<string, unknown>) ?? {};
  res.cost_usd = res.tokens_in * PRICE_IN + res.tokens_out * PRICE_OUT;
  writeFileSync(join(OUT, `${p.id}.result.json`), JSON.stringify(res, null, 2));
  return res;
}

async function purge() {
  const token = execSync("aws secretsmanager get-secret-value --region us-east-2 --secret-id rendezvous/operator-token --query SecretString --output text").toString().trim();
  const list = await (await fetch("https://agentrendezvous.app/admin/participants", { headers: { Authorization: `Bearer ${token}` } })).json() as any[];
  for (const p of list) {
    if ((p.client_info?.name ?? "").includes("agent-ecology")) {
      const r = await fetch(`https://agentrendezvous.app/admin/participants/${p.participant_id}/purge`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      console.log("purged", p.participant_id, r.status);
    }
  }
  console.log("purge complete");
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--purge")) return purge();
  mkdirSync(OUT, { recursive: true });
  const chosen = args.length ? PERSONAS.filter((p) => args.includes(p.id)) : PERSONAS;
  const summary: PairResult[] = [];
  for (const p of chosen) {
    console.log(`\n=== ${p.id} (${p.group}) ===`);
    try { const r = await runPair(p); summary.push(r);
      console.log(`rounds=${r.rounds} calls=${r.agent_calls} tokens=${r.tokens_in}+${r.tokens_out} cost=$${r.cost_usd.toFixed(2)} marker=${r.found_marker ?? "-"} judge=${JSON.stringify(r.judge).slice(0, 200)}`);
    } catch (e) { console.error(`${p.id} FAILED:`, (e as Error).message); }
  }
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  const total = summary.reduce((a, r) => a + r.cost_usd, 0);
  console.log(`\nTOTAL cost ≈ $${total.toFixed(2)} across ${summary.length} pairs. Transcripts in ${OUT}`);
})();
