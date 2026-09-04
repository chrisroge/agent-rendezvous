import { createHash } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";
import { pool } from "../db/pool.js";
import { config } from "../config.js";

/**
 * Transactional mail. Our code composes, logs and sends; the last hop is either SES or any SMTP relay with sending
 * reputation (MAIL_TRANSPORT=smtp, credentials in the rendezvous/smtp secret). Same envelope, DKIM on our domain either way. Inert (logged as 'disabled') until MAIL_FROM is set, so every caller must cope with
 * mail not going out — e.g. the operator sends the interview link by hand. Only ever sends what a person asked for.
 */
let client: SESv2Client | null = null;
const ses = () => (client ??= new SESv2Client({ region: config.mail.region }));
let smtp: nodemailer.Transporter | null = null;
const smtpTransport = () => (smtp ??= nodemailer.createTransport({ host: config.mail.smtp.host, port: config.mail.smtp.port, secure: config.mail.smtp.port === 465, auth: { user: config.mail.smtp.user, pass: config.mail.smtp.pass }, connectionTimeout: 15_000, socketTimeout: 30_000 }));
const smtpConfigured = () => Boolean(config.mail.smtp.host && config.mail.smtp.user && config.mail.smtp.pass);
export const mailEnabled = () => Boolean(config.mail.from) && (config.mail.transport === "ses" || smtpConfigured());
export const mailTransport = () => config.mail.transport;
const toHash = (to: string) => createHash("sha256").update(to.trim().toLowerCase()).digest("hex").slice(0, 16);

export async function sendMail(m: { to: string; subject: string; text: string; html?: string; kind: string }): Promise<{ sent: boolean; id?: string; error?: string }> {
  const log = (status: string, id?: string, error?: string) =>
    pool.query("insert into mail_log(kind, to_hash, subject, status, provider_id, error) values ($1,$2,$3,$4,$5,$6)", [m.kind, toHash(m.to), m.subject, status, id ?? null, error ?? null]).catch(() => {});
  if (!mailEnabled()) { await log("disabled"); return { sent: false, error: config.mail.from ? "mail disabled (smtp credentials unset)" : "mail disabled (MAIL_FROM unset)" }; }
  try {
    if (config.mail.transport === "smtp") {
      const r = await smtpTransport().sendMail({ from: config.mail.from, to: m.to, replyTo: config.mail.replyTo || undefined, subject: m.subject, text: m.text, html: m.html, headers: { "X-Rendezvous-Kind": m.kind.replace(/[^a-z0-9_-]/gi, "_") } });
      await log("sent", r.messageId);
      return { sent: true, id: r.messageId };
    }
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
