import type { Request, Response } from "express";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { safeEqual } from "../participants/ids.js";
import { emailHash } from "./ses.js";

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: "mail-webhook", ...o }));

/**
 * Postmark delivery events. Authenticated with HTTP Basic on the webhook URL (password = operator token), which is
 * what Postmark's webhook settings offer. Records what actually happened to each message and suppresses addresses
 * that hard-bounce or complain, so we never mail them twice.
 */
export async function postmarkWebhook(req: Request, res: Response): Promise<void> {
  const auth = req.header("authorization") ?? "";
  const supplied = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").slice(1).join(":") : "";
  if (!config.operatorToken || !supplied || !safeEqual(supplied, config.operatorToken)) { res.status(401).json({ error: "unauthorized" }); return; }

  const b = (req.body ?? {}) as Record<string, any>;
  const type = String(b.RecordType ?? "");
  const email = String(b.Email ?? b.Recipient ?? "");
  if (!email) { res.json({ ok: true, ignored: "no recipient" }); return; }
  const hash = emailHash(email);

  // Postmark bounce types that mean the address is permanently unusable. Soft failures are recorded but not suppressed.
  const HARD = new Set(["HardBounce", "BadEmailAddress", "SpamNotification", "ManuallyDeactivated", "Unsubscribe", "BlockedRecipient"]);
  let status = "event", reason: "hard_bounce" | "spam_complaint" | null = null;
  if (type === "Delivery") status = "delivered";
  else if (type === "SpamComplaint") { status = "complained"; reason = "spam_complaint"; }
  else if (type === "Bounce") { status = "bounced"; if (HARD.has(String(b.Type ?? ""))) reason = "hard_bounce"; }
  else if (type === "SubscriptionChange") { status = "unsubscribed"; if (b.SuppressSending) reason = "hard_bounce"; }

  const detail = String(b.Details ?? b.Description ?? b.Type ?? type).slice(0, 500);
  await pool.query("insert into mail_log(kind, to_hash, subject, status, provider_id, error) values ($1,$2,$3,$4,$5,$6)",
    [`postmark_${type || "unknown"}`, hash, String(b.Subject ?? "").slice(0, 300) || null, status, String(b.MessageID ?? "") || null, status === "delivered" ? null : detail]).catch(() => {});

  if (reason) {
    await pool.query("insert into mail_suppressions(email_hash, reason, detail) values ($1,$2,$3) on conflict (email_hash) do update set reason = excluded.reason, detail = excluded.detail",
      [hash, reason, detail]).catch(() => {});
    log({ level: "warn", msg: "address suppressed", type, reason });
  } else {
    log({ msg: "mail event", type, status });
  }
  res.json({ ok: true, status, suppressed: Boolean(reason) });
}
