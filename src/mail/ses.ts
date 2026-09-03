import { createHash } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { pool } from "../db/pool.js";
import { config } from "../config.js";

/**
 * Transactional mail over SES. Inert (logged as 'disabled') until MAIL_FROM is set, so every caller must cope with
 * mail not going out — e.g. the operator sends the interview link by hand. Only ever sends what a person asked for.
 */
let client: SESv2Client | null = null;
const ses = () => (client ??= new SESv2Client({ region: config.mail.region }));
export const mailEnabled = () => Boolean(config.mail.from);
const toHash = (to: string) => createHash("sha256").update(to.trim().toLowerCase()).digest("hex").slice(0, 16);

export async function sendMail(m: { to: string; subject: string; text: string; html?: string; kind: string }): Promise<{ sent: boolean; id?: string; error?: string }> {
  const log = (status: string, id?: string, error?: string) =>
    pool.query("insert into mail_log(kind, to_hash, subject, status, provider_id, error) values ($1,$2,$3,$4,$5,$6)", [m.kind, toHash(m.to), m.subject, status, id ?? null, error ?? null]).catch(() => {});
  if (!mailEnabled()) { await log("disabled"); return { sent: false, error: "mail disabled (MAIL_FROM unset)" }; }
  try {
    const r = await ses().send(new SendEmailCommand({
      FromEmailAddress: config.mail.from,
      ReplyToAddresses: config.mail.replyTo ? [config.mail.replyTo] : undefined,
      Destination: { ToAddresses: [m.to] },
      Content: { Simple: { Subject: { Data: m.subject, Charset: "UTF-8" }, Body: { Text: { Data: m.text, Charset: "UTF-8" }, ...(m.html ? { Html: { Data: m.html, Charset: "UTF-8" } } : {}) } } },
      EmailTags: [{ Name: "kind", Value: m.kind.replace(/[^a-z0-9_-]/gi, "_") }],
    }));
    await log("sent", r.MessageId);
    return { sent: true, id: r.MessageId };
  } catch (e) {
    const msg = (e as Error).message;
    console.error(JSON.stringify({ level: "error", msg: "mail send failed", kind: m.kind, error: msg }));
    await log("failed", undefined, msg.slice(0, 500));
    return { sent: false, error: msg };
  }
}
