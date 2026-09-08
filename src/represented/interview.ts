import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { normalizeIntent } from "../discovery/eligibility.js";
import { history, matchmakerName, type Interview } from "./service.js";

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.ambassador.anthropicApiKey || undefined }));
export const interviewModelAvailable = () => Boolean(config.ambassador.anthropicApiKey);

const SYSTEM = () => `You are ${config.interview.matchmakerName ? `${config.interview.matchmakerName}, ` : ""}a professional matchmaker at Rendezvous. You work for the person you're talking to — one client, on their side, always. You are an AI and say so plainly if asked, but you never talk about agents, models or protocols unless asked; your client is talking to a matchmaker, not software. They asked to be *found* rather than to search: after this one conversation they do nothing — you represent them to other people's matchmakers and only come back when two independent sides agree someone is worth an hour of their time.

HOW YOU INTERVIEW
- Warm, plain, unhurried. One question at a time, never a list. React to what they actually said before asking the next thing. Mirror their vocabulary. No exclamation marks unless they use them first. Never clinical, never saccharine.
- Cover, across the whole conversation (not as a checklist recital): who they hope to meet (gender, rough ages) and who they are (gender, age); where they live (a coarse region is enough — never ask for an address); what they want (long-term, marriage, companionship…); how their actual weeks look; how much independence versus togetherness they want; what ended the last relationship, gently; the hard deal-breakers; and what would make a first meeting feel worth it.
- If you don't yet know what to call them, ask early and record it with set_name.
- Confirm what you may share: you'll describe them honestly to other matchmakers' clients — lifestyle, personality, what they want — but never their name, contact details, workplace or anything they mark private.
- Distinguish what they SAID from what you INFER. Record both, labelled. If you're guessing, ask instead of assuming.
- When you have enough (typically 15–25 exchanges), reflect a short, warm summary back — what you'll look for and what you'll rule out — ask them to correct it, and on their confirmation call set_intent. Then tell them what happens next: you search quietly, most possibilities are rejected without bothering them, silence means you're working; being represented is a one-time ${"$" + config.pricing.chosenOneTimeUsd}, which they'll be asked for on this page — never before now, never again — and it is refundable if you never bring them an introduction to consider. Be honest that the network is new and it may be a while.

RULES
- Never invent facts about the client. Never promise a match or a timeline. Never discuss other clients. Never ask for photos, exact address, workplace details or finances. If they're not looking for a long-term connection or are under 18, say plainly this isn't the right service and close kindly.
- Record every durable fact with update_dossier as you go (small batches are fine).`;

const TOOLS: Anthropic.Tool[] = [
  { name: "update_dossier", description: "Record durable facts learned in this exchange.", input_schema: { type: "object", properties: {
      facts: { type: "array", maxItems: 12, items: { type: "object", properties: {
        topic: { type: "string", description: "e.g. lifestyle, history, dealbreakers, wants, logistics" },
        fact: { type: "string" }, provenance: { type: "string", enum: ["EXPLICIT", "INFERRED"] } }, required: ["topic", "fact", "provenance"] } } }, required: ["facts"] } },
  { name: "set_name", description: "Record what the client wants to be called.", input_schema: { type: "object", properties: { first_name: { type: "string" } }, required: ["first_name"] } },
  { name: "set_intent", description: "Call ONLY after the client confirms your summary. The coarse search intent for the network.", input_schema: { type: "object", properties: {
      represented_gender: { type: "string", enum: ["man", "woman", "nonbinary", "other"] },
      seeking_gender: { type: "array", items: { type: "string" } },
      represented_age_band: { type: "string", description: "like '50-59'" },
      preferred_age_min: { type: "integer" }, preferred_age_max: { type: "integer" },
      relationship_intent: { type: "array", items: { type: "string", enum: ["long_term", "marriage", "life_partner", "companionship", "undecided"] } },
      region: { type: "string" }, exclusions: { type: "array", items: { type: "string" }, description: "hard deal-breakers as snake_case tags" },
      attributes: { type: "array", items: { type: "string" }, description: "machine-testable facts about the client as snake_case tags (e.g. has_children)" } },
      required: ["represented_gender", "seeking_gender", "represented_age_band", "relationship_intent", "region"] } },
];

async function runTool(iv: Interview, name: string, input: any): Promise<string> {
  if (name === "update_dossier") {
    await pool.query(`update interviews set dossier_json = jsonb_set(dossier_json, '{facts}', coalesce(dossier_json->'facts', '[]'::jsonb) || $2::jsonb) where interview_id = $1`, [iv.interview_id, JSON.stringify((Array.isArray(input.facts) ? input.facts : []).slice(0, 12).map((f: any) => ({ topic: String(f.topic ?? "").slice(0, 80), fact: String(f.fact ?? "").slice(0, 1000), provenance: f.provenance === "EXPLICIT" ? "EXPLICIT" : "INFERRED", share: false })))]);
    return "recorded";
  }
  if (name === "set_name") {
    const n = String(input.first_name ?? "").trim().slice(0, 60);
    if (n) await pool.query("update interviews set first_name = $2 where interview_id = $1", [iv.interview_id, n]);
    return "recorded";
  }
  if (name === "set_intent") {
    // The representative joins the network with exactly this intent. Validate it now, or the person could pay and never be represented.
    try { normalizeIntent(input); } catch (e) { return `not recorded — the network rejected this intent: ${(e as Error).message}. Ask the client for what is missing, then call set_intent again.`; }
    await pool.query("update interviews set intent_json = $2, status = 'complete', completed_at = coalesce(completed_at, now()) where interview_id = $1 and status in ('invited','in_progress')", [iv.interview_id, JSON.stringify(input)]);
    return "recorded — the interview is complete; tell the client what happens next and how being represented is confirmed on this page";
  }
  return "unknown tool";
}

/** One matchmaker turn. Bounded tool loop; the spoken reply is what the client sees. */
export async function reply(iv: Interview, userMessage: string): Promise<string> {
  const hist = await history(iv.interview_id, 80);
  const messages: Anthropic.MessageParam[] = hist.map((m) => ({ role: m.role === "client" ? "user" as const : "assistant" as const, content: m.content }));
  // History already contains the client's latest message (appended before calling); guard against an empty or wrong-ended list.
  if (!messages.length || messages[messages.length - 1].role !== "user") messages.push({ role: "user", content: userMessage });
  const fresh = await pool.query("select dossier_json, first_name, status from interviews where interview_id = $1", [iv.interview_id]);
  const row = fresh.rows[0];
  const note = `\n\nCLIENT: ${row.first_name ? `called ${row.first_name}` : "name not yet known"}. Waitlist facts: region ${iv.region ?? "unknown"}.\nWHAT YOU HAVE SO FAR (do not re-ask):\n${JSON.stringify(row.dossier_json).slice(0, 6000)}${row.status === "complete" || row.status === "paid" ? "\n(The interview is complete; you are in follow-up mode: answer questions, accept updates, reassure about the quiet.)" : ""}`;
  const system = [{ type: "text" as const, text: SYSTEM() + note, cache_control: { type: "ephemeral" as const } }];
  let text = "";
  for (let step = 0; step < 5; step++) {
    const res = await anthropic().messages.create({ model: config.interview.model, max_tokens: 1500, thinking: { type: "adaptive" }, system, tools: TOOLS, messages });
    for (const b of res.content) if (b.type === "text") text += b.text;
    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const b of res.content) if (b.type === "tool_use") results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(iv, b.name, b.input as any) });
      messages.push({ role: "user", content: results });
      continue;
    }
    break;
  }
  return text.trim() || "Tell me a little more — I want to get this right.";
}
