import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { newId } from "../participants/ids.js";
import { sendMail, mailEnabled } from "../mail/ses.js";
import { inviteEmail } from "./emails.js";

export interface Interview {
  interview_id: string; waitlist_id: string | null; email: string; first_name: string | null; region: string | null;
  status: "invited" | "in_progress" | "complete" | "paid" | "expired" | "closed";
  dossier_json: { facts: { topic: string; fact: string; provenance: string }[] }; intent_json: Record<string, unknown> | null;
  client_turns: number; model: string | null; stripe_checkout_session_id: string | null; stripe_payment_intent_id: string | null;
  created_at: string; started_at: string | null; completed_at: string | null; paid_at: string | null; expires_at: string; last_seen_at: string | null;
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const interviewUrl = (token: string) => `${config.publicUrl}/interview/${token}`;
export const matchmakerName = () => config.interview.matchmakerName || "your matchmaker";

/** The first line the client sees, written at invite time so the page has something to show before any model call. */
export function opener(firstName: string | null): string {
  const name = config.interview.matchmakerName;
  const hello = firstName ? `Hi ${firstName} — ` : "Hi — ";
  return `${hello}${name ? `I'm ${name}, ` : "I'm "}your matchmaker at Rendezvous. You asked to be found rather than search, so this is the one conversation where you do the talking: who you are, how your weeks actually go, and who you're hoping to meet. Nothing you say is ever displayed to anyone; I use it only to answer other matchmakers' questions on your behalf. Take your time — you can close this and come back.${firstName ? "" : " To start: what should I call you?"}`;
}

/** Invite one waitlist entry: mint a single-use link, email it (if mail is enabled), mark the entry invited. Idempotent per entry. */
export async function inviteFromWaitlist(waitlistId: string): Promise<{ interview_id: string; url: string; mail_sent: boolean; mail_error?: string; already: boolean }> {
  const w = await pool.query("select waitlist_id, email, first_name, region, status from waitlist where waitlist_id = $1", [waitlistId]);
  const row = w.rows[0];
  if (!row) throw new Error("waitlist entry not found");
  const existing = await pool.query("select interview_id from interviews where waitlist_id = $1 and status in ('invited','in_progress','complete','paid') order by created_at desc limit 1", [waitlistId]);
  if (existing.rowCount) return { interview_id: existing.rows[0].interview_id, url: "(already invited; link was sent once and is not recoverable — close it and re-invite to issue a new one)", mail_sent: false, already: true };
  const token = `iv_${randomBytes(24).toString("base64url")}`;
  const id = newId("iv");
  const expires = new Date(Date.now() + config.interview.linkDays * 86400_000);
  await pool.query("insert into interviews(interview_id, waitlist_id, email, first_name, region, token_hash, expires_at, model) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, waitlistId, row.email, row.first_name ?? null, row.region ?? null, hashToken(token), expires, config.interview.model]);
  await pool.query("insert into interview_messages(interview_id, seq, role, content) values ($1, 1, 'matchmaker', $2)", [id, opener(row.first_name ?? null)]);
  await pool.query("update waitlist set status = 'invited', notified_at = now() where waitlist_id = $1", [waitlistId]);
  const url = interviewUrl(token);
  const mail = mailEnabled() ? await sendMail({ kind: "interview_invite", to: row.email, ...inviteEmail({ firstName: row.first_name ?? null, region: row.region ?? "your area", url, days: config.interview.linkDays }) }) : { sent: false, error: "mail disabled" };
  return { interview_id: id, url, mail_sent: mail.sent, mail_error: mail.error, already: false };
}

export async function inviteRegion(regionNormalized: string, limit = 25) {
  const rows = await pool.query("select waitlist_id from waitlist where region_normalized = $1 and status = 'waiting' order by created_at asc limit $2", [regionNormalized, limit]);
  const out = [];
  for (const r of rows.rows) { try { out.push({ waitlist_id: r.waitlist_id, ...(await inviteFromWaitlist(r.waitlist_id)) }); } catch (e) { out.push({ waitlist_id: r.waitlist_id, error: (e as Error).message }); } }
  return out;
}

/** Resolve a link token to its interview, expiring stale links on the way. */
export async function authInterview(token: string): Promise<Interview | null> {
  if (!/^iv_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const r = await pool.query("update interviews set last_seen_at = now() where token_hash = $1 returning *", [hashToken(token)]);
  const iv = r.rows[0] as Interview | undefined;
  if (!iv) return null;
  if ((iv.status === "invited" || iv.status === "in_progress") && new Date(iv.expires_at) < new Date()) {
    await pool.query("update interviews set status = 'expired' where interview_id = $1", [iv.interview_id]);
    iv.status = "expired";
  }
  return iv;
}

export async function history(interviewId: string, limit = 200) {
  const r = await pool.query("select seq, role, content from interview_messages where interview_id = $1 order by seq asc limit $2", [interviewId, limit]);
  return r.rows as { seq: number; role: "client" | "matchmaker"; content: string }[];
}

export async function appendMessage(interviewId: string, role: "client" | "matchmaker", content: string): Promise<number> {
  const r = await pool.query("insert into interview_messages(interview_id, seq, role, content) select $1, coalesce(max(seq),0)+1, $2, $3 from interview_messages where interview_id = $1 returning seq", [interviewId, role, content]);
  return r.rows[0].seq;
}

export async function adminInterviews() {
  const r = await pool.query("select interview_id, waitlist_id, email, first_name, region, status, client_turns, model, created_at, started_at, completed_at, paid_at, expires_at, last_seen_at from interviews order by created_at desc limit 200");
  const counts = await pool.query("select status, count(*)::int as n from interviews group by status");
  return { by_status: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])), interviews: r.rows };
}

export async function adminInterview(id: string) {
  const r = await pool.query("select * from interviews where interview_id = $1", [id]);
  if (!r.rowCount) return null;
  return { ...r.rows[0], messages: await history(id) };
}

export async function closeInterview(id: string): Promise<boolean> {
  const r = await pool.query("update interviews set status = 'closed' where interview_id = $1 and status not in ('paid') returning interview_id", [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function markPaid(interviewId: string, paymentIntent: string | null): Promise<boolean> {
  const r = await pool.query("update interviews set status = 'paid', paid_at = coalesce(paid_at, now()), stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id) where interview_id = $1 and status in ('complete','paid') returning interview_id", [interviewId, paymentIntent]);
  if (r.rowCount) await pool.query("update waitlist set status = 'joined' where waitlist_id = (select waitlist_id from interviews where interview_id = $1)", [interviewId]);
  return (r.rowCount ?? 0) > 0;
}
