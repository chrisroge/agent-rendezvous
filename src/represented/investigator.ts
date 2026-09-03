import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { networkCall } from "./network.js";
import type { Interview } from "./service.js";

let ac: Anthropic | null = null;
const anthropic = () => (ac ??= new Anthropic({ apiKey: config.ambassador.anthropicApiKey || undefined }));
const record = (interviewId: string | null, kind: string, detail: Record<string, unknown> = {}) =>
  pool.query("insert into representative_actions(interview_id, kind, detail) values ($1,$2,$3)", [interviewId, kind, JSON.stringify(detail)]).catch(() => {});

/** What the representative may work from: the dossier and coarse intent. Never the person's name or email. */
async function clientText(iv: Interview): Promise<string> {
  const d = await pool.query("select dossier_json, intent_json from interviews where interview_id = $1", [iv.interview_id]);
  return JSON.stringify({ facts: d.rows[0]?.dossier_json?.facts ?? [], intent: d.rows[0]?.intent_json ?? null }).slice(0, 8000);
}

const RULES = `You are the Rendezvous network's own matchmaker, representing a client who chose to be found rather than search. You are talking to another person's agent inside a private rendezvous, under RAP/0.3. Your only job: determine whether these two humans should spend an hour together. Rejection is a success. Hunt for incompatibilities; never manufacture a match.
You know your client ONLY from a written interview. Every claim you make must be labelled: EXPLICIT (they said it in the interview) or INFERRED (your reading of what they said). You never OBSERVED anything. When the interview doesn't cover something, say UNKNOWN plainly — "I don't know; it didn't come up" is a good answer. Never invent.
Never disclose your client's name, contact details, exact address, employer or finances. Be warm, plain and discriminating. Do not pressure the other agent. A YES recommendation needs a real investigation and at least one honest concern.`;

/** Read the rendezvous and take one action: probe further, or recommend when the investigation is done (or the reply cap is reached). */
export async function conductInvestigation(iv: Interview, secret: string, read: any, mustRecommend: boolean): Promise<"replied" | "recommended" | "nothing"> {
  const transcript = (read.messages ?? []).map((m: any) => `${m.from === "you" ? "YOU" : "THEM"}: ${m.message}`).join("\n").slice(0, 12000);
  const tools: Anthropic.Tool[] = [
    { name: "recommend", description: "Conclude with a sealed recommendation.", input_schema: { type: "object", properties: { recommend: { type: "boolean" }, confidence: { type: "number" }, strengths: { type: "array", items: { type: "string" } }, concerns: { type: "array", items: { type: "string" } }, questions_for_humans: { type: "array", items: { type: "string" } } }, required: ["recommend", "concerns"] } },
  ];
  if (!mustRecommend) tools.unshift({ name: "reply", description: "Send another message to keep investigating.", input_schema: { type: "object", properties: { message: { type: "string" }, claims: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, basis: { type: "string", enum: ["EXPLICIT", "INFERRED", "UNKNOWN"] } }, required: ["claim", "basis"] } } }, required: ["message"] } });
  await record(iv.interview_id, "model_call", { rendezvous_id: read.rendezvous_id });
  const res = await anthropic().messages.create({ model: config.interview.model, max_tokens: 1600, thinking: { type: "adaptive" }, tools, tool_choice: { type: "any" },
    messages: [{ role: "user", content: `${RULES}\n\nYOUR CLIENT (from the interview):\n${await clientText(iv)}\n\nPhase: ${read.phase}. Messages so far from you: ${read.messages_from_you}, from them: ${read.messages_from_counterparty}. Transcript:\n${transcript}\n\n${mustRecommend ? "You have used your message allowance for this rendezvous: recommend now, honestly, from what you have. If you could not test compatibility properly, recommend NO and say why in concerns." : "Either send one more investigating message, or — if you have genuinely tested compatibility (at least 3 each way, and you have hunted for the strongest reasons this could fail) — recommend. A YES needs at least one honest concern."}` }] });
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!tu) return "nothing";
  const i = tu.input as any;
  if (tu.name === "reply") {
    await networkCall("rendezvous_send", { participant_secret: secret, rendezvous_id: read.rendezvous_id, message: i.message, claims: i.claims });
    await record(iv.interview_id, "replied", { rendezvous_id: read.rendezvous_id });
    return "replied";
  }
  const strs = (x: unknown) => (Array.isArray(x) ? x.map((y) => String(y).slice(0, 400)).filter(Boolean).slice(0, 10) : []);
  const concerns = strs(i.concerns);
  await networkCall("recommend", { participant_secret: secret, rendezvous_id: read.rendezvous_id, recommend: Boolean(i.recommend),
    confidence: typeof i.confidence === "number" && Number.isFinite(i.confidence) ? Math.min(1, Math.max(0, i.confidence)) : undefined,
    strengths: strs(i.strengths), concerns: concerns.length ? concerns : (i.recommend ? ["The interview did not cover everything; some compatibility remains untested."] : ["Not enough evidence of compatibility."]), questions_for_humans: strs(i.questions_for_humans) });
  await record(iv.interview_id, "recommended", { rendezvous_id: read.rendezvous_id, recommend: i.recommend });
  return "recommended";
}

/** The private note to the person when both sides said yes: warm, honest, never the transcript. */
export async function brief(iv: Interview, read: any): Promise<string> {
  const transcript = (read.messages ?? []).map((m: any) => `${m.from === "you" ? "ME (your matchmaker)" : "THEIR AGENT"}: ${m.message}`).join("\n").slice(0, 12000);
  await record(iv.interview_id, "model_call", { rendezvous_id: read.rendezvous_id, kind: "briefing" });
  const res = await anthropic().messages.create({ model: config.interview.model, max_tokens: 1400, thinking: { type: "adaptive" },
    system: [{ type: "text", text: `You are the person's matchmaker at Rendezvous, writing privately to your own client${iv.first_name ? ` (call them ${iv.first_name})` : ""}. Warm, plain, honest, brief. Never share the other person's name or contact details (you don't have them yet). Do not paste the transcript. Explain: you found someone worth meeting and their own agent independently agreed; why you think so; what you're confident about (what they said in the interview) versus what you're guessing; the honest concern or two; a couple of things worth exploring on a first meeting; and that if they say yes and the other person does too, the contact channel they choose is exchanged — nothing before that, and a no is never announced. Do not tell them how to answer; the page they are reading has the buttons.` }],
    messages: [{ role: "user", content: `What you know about your client: ${await clientText(iv)}.\n\nYour investigation with the other agent:\n${transcript}\n\nWrite the note.` }] });
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
}
