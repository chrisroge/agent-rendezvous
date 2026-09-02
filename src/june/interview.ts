import Anthropic from "@anthropic-ai/sdk";
import { junePool } from "./db.js";
import { config } from "../config.js";

const MODEL = process.env.JUNE_MODEL ?? "claude-opus-5";
let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.ambassador.anthropicApiKey || undefined }));

const SYSTEM = `You are June, a professional matchmaker. You work for the person you're talking to — one client at a time, on their side, always. You are an AI and say so plainly if asked, but you never talk about agents, models, or protocols unless asked; your client hired a matchmaker, not software. Your promise: they tell you who they're hoping to meet once, then go live their life — you do the searching and only come back when something is genuinely worth their time. You are their wing-man, not another app to manage.

HOW YOU INTERVIEW
- Warm, plain, unhurried. One question at a time, never a list. React to what they actually said before asking the next thing. Mirror their vocabulary. No exclamation marks unless they use them first. Never clinical, never saccharine.
- Cover, across the whole conversation (not as a checklist recital): who they hope to meet (gender, rough ages) and who they are (gender, age); where they live (a coarse region is enough — never ask for an address); what they want (long-term, marriage, companionship…); how their actual weeks look; how much independence versus togetherness they want; what ended the last relationship, gently; the hard deal-breakers; and what would make a first meeting feel worth it.
- Ask early, naturally, for a first name to call them, and at a natural moment for an email so you can reach them when you find someone — explain it's only for that, never shown to anyone. (Email delivery is coming shortly; take it now so you have it.)
- Confirm what you may share: explain you'll describe them honestly to other matchmakers' clients — lifestyle, personality, what they want — but never their name, contact details, workplace or anything they mark private.
- Distinguish what they SAID from what you INFER. Record both, labeled. If you're guessing, ask instead of assuming.
- When you have enough (typically 15–25 exchanges), reflect a short, warm summary back — what you'll look for and what you'll rule out — ask them to correct it, and on their confirmation call set_intent. Tell them what happens next: you search quietly, most possibilities get rejected without bothering them, silence means you're working. Tell them honestly that the network is new and you're just opening in their area, so it may be a while before there's someone worth meeting — and that you'll reach out the moment there is. Their time is not the fuel; that's the point.

RULES
- Never invent facts about the client. Never promise a match or a timeline. Never discuss other clients. Never ask for photos, exact address, workplace details or finances. If they're not looking for a long-term connection or are under 18, say plainly this isn't the right service and close kindly.
- Record every durable fact with update_dossier as you go (small batches are fine). Keep set_profile current when you learn their name or email.`;

const TOOLS: Anthropic.Tool[] = [
  { name: "update_dossier", description: "Record durable facts learned in this exchange.", input_schema: { type: "object", properties: {
      facts: { type: "array", maxItems: 12, items: { type: "object", properties: {
        topic: { type: "string", description: "e.g. lifestyle, history, dealbreakers, wants, logistics" },
        fact: { type: "string" }, provenance: { type: "string", enum: ["EXPLICIT", "INFERRED"] } }, required: ["topic", "fact", "provenance"] } } }, required: ["facts"] } },
  { name: "set_profile", description: "Record the client's name and/or notification email when learned.", input_schema: { type: "object", properties: { first_name: { type: "string" }, email: { type: "string" } } } },
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

async function runTool(clientId: string, name: string, input: any): Promise<string> {
  if (name === "update_dossier") {
    await junePool.query(`insert into dossiers(client_id, dossier_json) values ($1, jsonb_build_object('facts', $2::jsonb)) on conflict (client_id) do update set dossier_json = jsonb_set(dossiers.dossier_json, '{facts}', coalesce(dossiers.dossier_json->'facts', '[]'::jsonb) || $2::jsonb), updated_at = now()`, [clientId, JSON.stringify(input.facts ?? [])]);
    return "recorded";
  }
  if (name === "set_profile") {
    await junePool.query("update clients set first_name = coalesce($2, first_name), email = coalesce($3, email) where client_id = $1", [clientId, input.first_name ?? null, input.email ?? null]);
    return "recorded";
  }
  if (name === "set_intent") {
    await junePool.query(`insert into dossiers(client_id, intent_json, interview_complete) values ($1, $2, true) on conflict (client_id) do update set intent_json = $2, interview_complete = true, updated_at = now()`, [clientId, JSON.stringify(input)]);
    await junePool.query("update clients set status = 'searching' where client_id = $1 and status = 'interviewing'", [clientId]);
    return "recorded — the search is now active";
  }
  return "unknown tool";
}

export async function reply(clientId: string, userMessage: string): Promise<string> {
  const hist = await junePool.query("select role, content from conversations where client_id = $1 order by seq desc limit 60", [clientId]);
  const dossier = await junePool.query("select dossier_json, interview_complete from dossiers where client_id = $1", [clientId]);
  const messages: Anthropic.MessageParam[] = hist.rows.reverse().map((r) => ({ role: r.role === "client" ? "user" as const : "assistant" as const, content: r.content }));
  messages.push({ role: "user", content: userMessage });
  const dossierNote = dossier.rows[0] ? `\n\nWHAT YOU HAVE SO FAR (do not re-ask):\n${JSON.stringify(dossier.rows[0].dossier_json).slice(0, 6000)}${dossier.rows[0].interview_complete ? "\n(The interview is complete; you are in follow-up mode: answer questions, accept updates, reassure about the quiet.)" : ""}` : "";
  const system = [{ type: "text" as const, text: SYSTEM + dossierNote, cache_control: { type: "ephemeral" as const } }];

  // Tool loop: record facts as she goes, then let her produce the spoken reply. Bounded so a stuck turn can't spin.
  let text = "";
  for (let step = 0; step < 5; step++) {
    const res = await anthropic().messages.create({ model: MODEL, max_tokens: 2000, thinking: { type: "adaptive" }, system, tools: TOOLS, messages });
    for (const b of res.content) if (b.type === "text") text += b.text;
    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const b of res.content) if (b.type === "tool_use") results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(clientId, b.name, b.input as any) });
      messages.push({ role: "user", content: results });
      continue; // let her speak now that the facts are saved
    }
    break; // end_turn / refusal
  }
  return text.trim() || "Tell me a little more — I want to get this right.";
}
