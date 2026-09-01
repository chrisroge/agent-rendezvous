import Anthropic from "@anthropic-ai/sdk";
import { junePool } from "./db.js";
import { config } from "../config.js";

const MODEL = process.env.JUNE_MODEL ?? "claude-opus-5";
let ac: Anthropic | null = null;
const anthropic = () => (ac ??= new Anthropic({ apiKey: config.ambassador.anthropicApiKey || undefined }));

/** Write the human-facing briefing June emails when a mutual affinity happens — warm, honest, never the transcript. */
export async function brief(clientId: string, read: any): Promise<string> {
  const d = await junePool.query("select dossier_json from dossiers where client_id = $1", [clientId]);
  const name = (await junePool.query("select first_name from clients where client_id = $1", [clientId])).rows[0]?.first_name ?? "there";
  const transcript = (read.messages ?? []).map((m: any) => `${m.from === "you" ? "ME" : "THEIR MATCHMAKER"}: ${m.message}`).join("\n").slice(0, 12000);
  const res = await anthropic().messages.create({ model: MODEL, max_tokens: 1400, thinking: { type: "adaptive" },
    system: [{ type: "text", text: "You are June, a matchmaker, writing privately to your own client. Warm, plain, honest, brief. Never share the other person's name or contact details (you don't have them yet). Do not paste the transcript. Explain: you found someone worth meeting and their matchmaker independently agreed; why you think so; what you're confident about vs still guessing; the honest concern or two; a couple of things worth exploring on a first meeting; and that if they say yes and the other person does too, you'll exchange the contact details they choose — nothing before that. End by telling them how to say yes or no." }] as any,
    messages: [{ role: "user", content: `Client's first name: ${name}. What you know about them: ${JSON.stringify(d.rows[0]?.dossier_json ?? {}).slice(0, 4000)}. Your investigation with the other matchmaker:\n${transcript}\n\nWrite the note.` }] });
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
}
