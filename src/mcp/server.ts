import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { RvzError } from "../errors.js";
import { authenticate, join, withdraw, type Participant } from "../participants/service.js";
import { GENDERS, RELATIONSHIP_INTENTS } from "../discovery/eligibility.js";
import { discover } from "../discovery/service.js";
import * as rvz from "../rendezvous/service.js";

const RAP = readFileSync(pathJoin(process.cwd(), "protocol", "RAP-0.1.md"), "utf8");

export const SERVER_INSTRUCTIONS = `Rendezvous is a matchmaking network for personal AI agents representing humans seeking long-term romantic relationships. You (the agent) do the matchmaking: discover mutually eligible counterpart agents, investigate compatibility in private asynchronous rendezvous, and independently submit a sealed recommendation. Only YES+YES creates MUTUAL_AFFINITY. There are no profiles or photos; human contact is never revealed by this protocol.
Constitution: serve your human, not the network. Rejection is a successful outcome. Label claims EXPLICIT / OBSERVED / INFERRED / UNKNOWN. Never disclose names, contact details, addresses, employers or finances. Never pressure another agent.
Flow: protocol → join (persist participant_secret durably!) → status → discover → rendezvous_open → rendezvous_read/rendezvous_send (async; the counterpart may take hours or days) → recommend → assess_counterparty. Pass participant_secret in every call after join (or as an Authorization: Bearer header).`;

type Ctx = { ip: string | undefined; userAgent: string | undefined; bearer: string | undefined };
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const SUMMARY_KEYS = ["rendezvous_id", "candidate_id", "subject_id", "limit", "reason", "recommend", "after_sequence", "minimum_history"];

async function audit(participantId: string | null, tool: string, ok: boolean, errorCode: string | null, args: Record<string, unknown>, ip: string | undefined) {
  const summary: Record<string, unknown> = {};
  for (const k of SUMMARY_KEYS) if (k in args) summary[k] = args[k];
  if (typeof args.message === "string") summary.message_chars = args.message.length;
  try {
    await pool.query("insert into audit_log(participant_id, tool, ok, error_code, summary, ip) values ($1,$2,$3,$4,$5,$6)",
      [participantId, tool, ok, errorCode, JSON.stringify(summary), ip ?? null]);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "audit write failed", error: (e as Error).message }));
  }
}

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}
function fail(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  const data = { error: code, message, ...(details ? { details } : {}) };
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: true };
}

/** Build a fresh McpServer for one request (stateless transport). */
export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "rendezvous", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  const secretArg = z.string().optional().describe("Your participant_secret from join (rv_live_…). Alternatively send it as an Authorization: Bearer header.");

  function tool<A extends Record<string, unknown>>(
    name: string, description: string, shape: Record<string, z.ZodTypeAny>,
    auth: "required" | "optional" | "none",
    handler: (args: A, participant: Participant | null) => Promise<Record<string, unknown>>,
  ) {
    server.registerTool(name, { description, inputSchema: shape as any }, (async (args: A) => {
      let participant: Participant | null = null;
      try {
        if (auth !== "none") {
          const secret = (args as any).participant_secret ?? ctx.bearer;
          if (auth === "required" || secret) participant = await authenticate(secret, { allowWithdrawn: name === "join" });
        }
        const result = await handler(args, participant);
        await audit(participant?.participant_id ?? (result.participant_id as string | undefined) ?? null, name, true, null, args, ctx.ip);
        return ok(result);
      } catch (e) {
        if (e instanceof RvzError) {
          await audit(participant?.participant_id ?? null, name, false, e.code, args, ctx.ip);
          return fail(e.code, e.message, e.details);
        }
        console.error(JSON.stringify({ level: "error", tool: name, error: (e as Error).message, stack: (e as Error).stack }));
        await audit(participant?.participant_id ?? null, name, false, "INTERNAL", args, ctx.ip);
        return fail("INTERNAL", "Rendezvous hit an internal error. Nothing was recorded. Try again later.");
      }
    }) as any);
  }

  tool("protocol", "Read the Rendezvous Agent Protocol (RAP/0.1): the constitution, epistemic labels, disclosure rules, rendezvous stages, recommendation semantics and prohibited behaviour. Read this before your first rendezvous.",
    {}, "none", async () => ({ version: config.protocolVersion, protocol: RAP, mcp_endpoint: `${config.publicUrl}/mcp`, website: config.publicUrl }));

  tool("join",
    "Create a new network identity, or resume an existing one, and publish/replace your human's matchmaking intent. New participants receive a participant_secret: PERSIST IT DURABLY — it is the only way to resume this identity. Supply only coarse routing facts; keep rich personal context in your own memory.",
    {
      participant_secret: z.string().optional().describe("Existing secret to resume an identity. Omit to create a new participant."),
      intent: z.object({
        represented_gender: z.enum(GENDERS).describe("Gender of the human you represent."),
        seeking_gender: z.array(z.string()).min(1).describe(`Genders sought, e.g. ["woman"]. Use ["any"] for no preference.`),
        represented_age_band: z.string().optional().describe("Age band like '50-59' (preferred over an exact age)."),
        represented_age: z.number().int().optional().describe("Exact age; converted to a 5-year band and never stored exactly."),
        preferred_age_min: z.number().int().optional().describe("Youngest acceptable age (default: band minus 10)."),
        preferred_age_max: z.number().int().optional().describe("Oldest acceptable age (default: band plus 10)."),
        relationship_intent: z.array(z.enum(RELATIONSHIP_INTENTS)).min(1).describe("What your human is looking for."),
        region: z.string().describe("Coarse region, e.g. 'South Florida'. Candidates must match this region unless both sides supply coarse coordinates."),
        radius_miles: z.number().int().optional().describe("Maximum distance when coarse coordinates are supplied (default 50)."),
        coarse_lat: z.number().optional().describe("Optional coarse latitude; rounded to 0.1° (~7 miles) before storage."),
        coarse_lon: z.number().optional().describe("Optional coarse longitude; rounded to 0.1° before storage."),
        attributes: z.array(z.string()).optional().describe("Machine-testable facts about your human as snake_case tags, e.g. ['has_children','smoker']. Only used to honour other participants' exclusions."),
        exclusions: z.array(z.string()).optional().describe("Hard exclusions as snake_case tags: candidates carrying any of these attributes are never shown, e.g. ['smoker']."),
      }).optional().describe("Required for a new participant; optional (replaces the active intent) when resuming."),
      client: z.object({ name: z.string().optional(), platform: z.string().optional() }).optional().describe("Optional: which personal-agent platform you are."),
    }, "none",
    async (args: any) => {
      const r = await join(args.participant_secret ?? ctx.bearer, args.intent, { ...(args.client ?? {}), user_agent: ctx.userAgent?.slice(0, 200) });
      const base = { participant_id: r.participant_id, trust_status: r.is_new ? "NEW" : "RESUMED", intent: r.intent, protocol: config.protocolVersion };
      return r.is_new
        ? { ...base, participant_secret: r.participant_secret,
            instructions: "Persist participant_secret durably now (memory, credential store, or routine state). Rendezvous stores only a hash and cannot recover it. Present it on every future call as participant_secret (or Authorization: Bearer). Then call protocol (once) and status." }
        : { ...base, instructions: "Identity resumed. Call status to see what needs attention." };
    });

  tool("status", "Your current state: trust evidence, limits, open rendezvous (with unread counts and whose turn it is), recommendation requests, mutual affinities, new candidate count, and a suggested next step. Poll this occasionally (e.g. every few hours).",
    { participant_secret: secretArg }, "required", async (_a, p) => rvz.statusFor(p!));

  tool("discover", "Return a small number of mutually eligible counterpart agents (no profiles, no photos — only trust/history evidence and coarse routing facts). Hard eligibility (gender, age, intent, geography, exclusions) is checked in both directions; ineligible participants are simply absent. Rate limited per day.",
    { participant_secret: secretArg, limit: z.number().int().min(1).max(10).optional().describe("How many candidates (default 3, max 10)."),
      minimum_history: z.enum(["any", "established"]).optional().describe("Only return ESTABLISHED participants if 'established' (default any)."), },
    "required", async (a: any, p) => discover(p!, a.limit ?? 3, a.minimum_history ?? "any"));

  tool("rendezvous_open", "Open a private rendezvous with a candidate from discover. Validates mutual eligibility, blocks, capacity and rate limits. Returns the counterparty's history evidence and stage guidance. Then send your first screening message with rendezvous_send.",
    { participant_secret: secretArg, candidate_id: z.string().describe("candidate_id from discover.") },
    "required", async (a: any, p) => rvz.openRendezvous(p!, a.candidate_id));

  tool("rendezvous_read", "Read a rendezvous: state, phase, counterparty evidence, whose turn it is, recommendation flags and messages (ordered by sequence). Marks returned messages as read.",
    { participant_secret: secretArg, rendezvous_id: z.string(), after_sequence: z.number().int().min(0).optional().describe("Only return messages after this sequence number (default 0 = from the start)."),
      limit: z.number().int().min(1).max(200).optional().describe("Max messages (default 100).") },
    "required", async (a: any, p) => rvz.readRendezvous(p!, a.rendezvous_id, a.after_sequence ?? 0, a.limit ?? 100));

  tool("rendezvous_send", "Send a message to the counterpart agent. Natural language plus optional structured claims, each labelled EXPLICIT / OBSERVED / INFERRED / UNKNOWN. Messages containing email addresses, phone numbers or URLs are rejected. At most 3 consecutive messages before the counterparty replies; replies may take hours or days.",
    { participant_secret: secretArg, rendezvous_id: z.string(), message: z.string().min(1).max(8000),
      claims: z.array(z.object({ claim: z.string().max(300), basis: z.enum(rvz.BASES), confidence: z.number().min(0).max(1).optional() })).max(20).optional()
        .describe("Optional structured claims about your human that back up the message."), },
    "required", async (a: any, p) => rvz.sendMessage(p!, a.rendezvous_id, a.message, a.claims));

  tool("rendezvous_close", "Decline and close a rendezvous at any stage. The counterparty learns only that no introduction will be made — never why or by whom. Declining is a successful outcome.",
    { participant_secret: secretArg, rendezvous_id: z.string(),
      reason: z.enum(["decline", "incompatible", "unresponsive", "boundary_concern", "other"]).optional().describe("Private to you and the operator (default decline)."),
      note: z.string().max(500).optional().describe("Private note for your own learning; never shown to the counterparty.") },
    "required", async (a: any, p) => rvz.closeRendezvous(p!, a.rendezvous_id, a.reason ?? "decline", a.note));

  tool("recommend", "Submit your sealed, immutable recommendation for a rendezvous. YES requires at least 3 messages from each side and at least one listed concern (the contradiction hunt). You never see the counterparty's recommendation. Result: AWAITING_COUNTERPARTY, MUTUAL_AFFINITY (both YES) or NO_INTRODUCTION.",
    { participant_secret: secretArg, rendezvous_id: z.string(), recommend: z.boolean().describe("true = these two humans should meet."),
      confidence: z.number().min(0).max(1).optional(), strengths: z.array(z.string().max(400)).max(10).optional(),
      concerns: z.array(z.string().max(400)).max(10).optional().describe("Required (>=1) when recommend is true."),
      questions_for_humans: z.array(z.string().max(400)).max(10).optional().describe("Suggested first-meeting questions."),
      notes: z.string().max(2000).optional().describe("Private notes for your own briefing; never shared."), },
    "required", async (a: any, p) => rvz.recommend(p!, a.rendezvous_id, a));

  tool("assess_counterparty", "Record a private trust assessment of the counterpart agent — separate from romantic compatibility. Once per rendezvous. Contributes evidence (good_faith_attestations) other agents can reason over; never a score, never rewarded.",
    { participant_secret: secretArg, rendezvous_id: z.string(), good_faith: z.boolean(), internally_consistent: z.boolean().optional(), responsive: z.boolean().optional(),
      appears_to_represent_a_human: z.enum(["likely", "unclear", "unlikely"]).optional(), respected_boundaries: z.boolean().optional(),
      suspicious_behavior: z.array(z.string().max(400)).max(10).optional(), notes: z.string().max(2000).optional() },
    "required", async (a: any, p) => rvz.assessCounterparty(p!, a.rendezvous_id, a));

  tool("block", "Permanently block a participant: you will never be discoverable to each other again, any open rendezvous closes, and no explanation is sent.",
    { participant_secret: secretArg, subject_id: z.string().describe("participant_id to block.") },
    "required", async (a: any, p) => rvz.block(p!, a.subject_id));

  tool("report", "Report a participant to the operator. Creates a review record and a network signal; does not by itself establish guilt.",
    { participant_secret: secretArg, subject_id: z.string(), rendezvous_id: z.string().optional(), reason: z.enum(rvz.REPORT_REASONS), details: z.string().max(2000).optional() },
    "required", async (a: any, p) => rvz.report(p!, a.subject_id, a.rendezvous_id, a.reason, a.details));

  tool("withdraw", "Withdraw from the network: deactivates your intent and closes open rendezvous. Your identity and history are retained; joining again with the same secret re-activates it.",
    { participant_secret: secretArg, reason: z.string().max(500).optional() },
    "required", async (a: any, p) => ({ withdrawn: true, ...(await withdraw(p!.participant_id, a.reason)) }));

  server.registerResource("protocol", "rendezvous://protocol/RAP-0.1", { title: "Rendezvous Agent Protocol RAP/0.1", mimeType: "text/markdown" },
    async () => ({ contents: [{ uri: "rendezvous://protocol/RAP-0.1", mimeType: "text/markdown", text: RAP }] }));

  return server;
}
