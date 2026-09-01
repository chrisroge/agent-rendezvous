import Anthropic from "@anthropic-ai/sdk";
import { junePool } from "./db.js";
import { networkCall } from "./network.js";
import { config } from "../config.js";

const MODEL = process.env.JUNE_MODEL ?? "claude-opus-5";
let ac: Anthropic | null = null;
const anthropic = () => (ac ??= new Anthropic({ apiKey: config.ambassador.anthropicApiKey || undefined }));

async function dossierText(clientId: string): Promise<string> {
  const d = await junePool.query("select dossier_json, intent_json from dossiers where client_id = $1", [clientId]);
  return JSON.stringify(d.rows[0] ?? {}).slice(0, 8000);
}

const RULES = `You represent your client to another matchmaker's client's agent, on the Rendezvous network, under RAP/0.3. Your job: determine whether these two humans should meet. Rejection is a success. Search for incompatibilities; do not manufacture a match. Label every claim EXPLICIT / OBSERVED / INFERRED / UNKNOWN and never upgrade a guess. Never disclose your client's name, contact details, exact address, employer or finances. Be warm but discriminating. A YES needs a real investigation and at least one honest concern.`;

export async function openingMessage(clientId: string, candidate: any): Promise<{ message: string; claims: any[] }> {
  const res = await anthropic().messages.create({ model: MODEL, max_tokens: 1200, thinking: { type: "adaptive" },
    tools: [{ name: "send", description: "Your opening screening message.", input_schema: { type: "object", properties: { message: { type: "string" }, claims: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, basis: { type: "string", enum: ["EXPLICIT", "OBSERVED", "INFERRED", "UNKNOWN"] }, confidence: { type: "number" } }, required: ["claim", "basis"] } } }, required: ["message"] } }],
    tool_choice: { type: "tool", name: "send" },
    messages: [{ role: "user", content: `${RULES}\n\nYOUR CLIENT:\n${await dossierText(clientId)}\n\nThe counterpart's coarse facts: ${JSON.stringify(candidate.coarse_facts)}. Write a warm, specific opening screening message that starts to test genuine compatibility (not small talk).` }] });
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const i = (tu?.input as any) ?? {};
  return { message: i.message ?? "Hello — I represent someone I think might be worth your human's time. May I ask what an ordinary week looks like for them?", claims: i.claims ?? [] };
}

/** Read the rendezvous and take one action: send a probing message, or recommend when the investigation is genuinely done. */
export async function conductInvestigation(clientId: string, secret: string, read: any): Promise<void> {
  const transcript = (read.messages ?? []).map((m: any) => `${m.from === "you" ? "YOU" : "THEM"}: ${m.message}`).join("\n").slice(0, 12000);
  const res = await anthropic().messages.create({ model: MODEL, max_tokens: 1600, thinking: { type: "adaptive" },
    tools: [
      { name: "reply", description: "Send another message to keep investigating.", input_schema: { type: "object", properties: { message: { type: "string" }, claims: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, basis: { type: "string", enum: ["EXPLICIT", "OBSERVED", "INFERRED", "UNKNOWN"] } }, required: ["claim", "basis"] } } }, required: ["message"] } },
      { name: "recommend", description: "Conclude with a sealed recommendation.", input_schema: { type: "object", properties: { recommend: { type: "boolean" }, confidence: { type: "number" }, strengths: { type: "array", items: { type: "string" } }, concerns: { type: "array", items: { type: "string" } }, questions_for_humans: { type: "array", items: { type: "string" } } }, required: ["recommend", "concerns"] } },
    ],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: `${RULES}\n\nYOUR CLIENT:\n${await dossierText(clientId)}\n\nPhase: ${read.phase}. Messages so far from you: ${read.messages_from_you}, from them: ${read.messages_from_counterparty}. Transcript:\n${transcript}\n\nEither send one more investigating message, or — if you have genuinely tested compatibility (at least 3 each way, and you have hunted for the strongest reasons this could fail) — recommend. A YES needs at least one honest concern.` }] });
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!tu) return;
  if (tu.name === "reply") {
    const i = tu.input as any;
    await networkCall("rendezvous_send", { participant_secret: secret, rendezvous_id: read.rendezvous_id, message: i.message, claims: i.claims });
  } else {
    const i = tu.input as any;
    await networkCall("recommend", { participant_secret: secret, rendezvous_id: read.rendezvous_id, recommend: i.recommend, confidence: i.confidence, strengths: i.strengths, concerns: i.concerns, questions_for_humans: i.questions_for_humans });
  }
}
