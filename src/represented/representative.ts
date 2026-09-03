import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { newId } from "../participants/ids.js";
import { trustEvent } from "../participants/service.js";
import { networkCall } from "./network.js";
import { conductInvestigation, brief } from "./investigator.js";
import { sendMail, mailEnabled } from "../mail/ses.js";
import { briefingEmail, revealEmail, noIntroductionEmail } from "./emails.js";
import type { Interview } from "./service.js";

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: "representative", ...o }));
const record = (interviewId: string | null, kind: string, detail: Record<string, unknown> = {}) =>
  pool.query("insert into representative_actions(interview_id, kind, detail) values ($1,$2,$3)", [interviewId, kind, JSON.stringify(detail)]).catch(() => {});
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const consentUrl = (token: string) => `${config.publicUrl}/introduction/${token}`;
export const REPRESENTATIVE_CLIENT = { name: "rendezvous-representative", platform: "represented" };

/** Join (or refresh) this person's network identity from their confirmed intent; comp membership so the representative can reply. */
async function ensureOnNetwork(iv: Interview): Promise<string> {
  const cur = await pool.query("select network_secret, intent_json from interviews where interview_id = $1", [iv.interview_id]);
  const intent = cur.rows[0]?.intent_json;
  if (!intent) throw new Error("no confirmed intent");
  if (cur.rows[0].network_secret) {
    await networkCall("join", { participant_secret: cur.rows[0].network_secret, intent, client: REPRESENTATIVE_CLIENT });
    return cur.rows[0].network_secret as string;
  }
  const r = await networkCall("join", { intent, client: REPRESENTATIVE_CLIENT });
  await pool.query("update interviews set network_secret = $2, network_participant_id = $3, network_joined_at = now() where interview_id = $1", [iv.interview_id, r.participant_secret, r.participant_id]);
  // Represented people never pay membership: the seeker's price covers their side. Comp it, as an operator action, so replies are allowed.
  await pool.query("update participants set plan = 'member', plan_status = 'comped', plan_updated_at = now() where participant_id = $1", [r.participant_id]);
  await trustEvent(pool, r.participant_id, "membership_comped", { metadata: { reason: "represented participant" } });
  await record(iv.interview_id, "joined", { participant_id: r.participant_id });
  return r.participant_secret as string;
}

async function modelCallsToday(): Promise<number> {
  const r = await pool.query("select count(*)::int as n from representative_actions where kind = 'model_call' and at > now() - interval '1 day'");
  return r.rows[0].n;
}

/** One cycle for one person. Never opens a rendezvous, never discovers: it only answers what seekers bring. */
async function cycleOne(iv: Interview, budget: { calls: number }): Promise<void> {
  const secret = await ensureOnNetwork(iv);
  const status = await networkCall("status", { participant_secret: secret });

  // 1. Mutual affinities → one briefing each, emailed with a consent link.
  for (const aff of status.mutual_affinities ?? []) {
    const have = await pool.query("select briefing_id, consent_state, token_hash, contact_shared, outcome_sent_at from briefings where interview_id = $1 and rendezvous_id = $2", [iv.interview_id, aff.rendezvous_id]);
    const intro = aff.introduction ?? {};
    if (!have.rowCount) {
      if (intro.state && intro.state !== "AWAITING_BOTH") continue; // window already closed before we ever briefed
      if (budget.calls <= 0) continue;
      budget.calls--;
      const read = await networkCall("rendezvous_read", { participant_secret: secret, rendezvous_id: aff.rendezvous_id, limit: 200 });
      const body = await brief(iv, read);
      const token = `ic_${randomBytes(24).toString("base64url")}`;
      const id = newId("bf");
      await pool.query("insert into briefings(briefing_id, interview_id, rendezvous_id, body, token_hash) values ($1,$2,$3,$4,$5)", [id, iv.interview_id, aff.rendezvous_id, body, hashToken(token)]);
      const mail = mailEnabled() ? await sendMail({ kind: "briefing", to: iv.email, ...briefingEmail({ firstName: iv.first_name, url: consentUrl(token) }) }) : { sent: false };
      if (mail.sent) await pool.query("update briefings set mail_sent_at = now() where briefing_id = $1", [id]);
      await record(iv.interview_id, "briefing", { rendezvous_id: aff.rendezvous_id, mail_sent: mail.sent, consent_url_issued: true });
      log({ msg: "briefing issued", interview: iv.interview_id, rendezvous: aff.rendezvous_id, mail_sent: mail.sent });
      continue;
    }
    const b = have.rows[0];
    // 2. Outcomes after the person answered: reveal (both yes) or a quiet close.
    if (intro.state === "REVEALED" && b.consent_state !== "REVEALED") {
      // The status feed only carries the state; the contact channel comes from the introduction tool itself.
      const full = await networkCall("introduction", { participant_secret: secret, rendezvous_id: aff.rendezvous_id, action: "status" });
      const contact = full.counterparty_contact ?? intro.counterparty_contact ?? null;
      await pool.query("update briefings set consent_state = 'REVEALED', counterpart_contact = $2, outcome_sent_at = now() where briefing_id = $1", [b.briefing_id, contact]);
      if (mailEnabled()) await sendMail({ kind: "reveal", to: iv.email, ...revealEmail({ firstName: iv.first_name, contact: String(contact ?? ""), url: consentUrl("") }) });
      await record(iv.interview_id, "reveal", { rendezvous_id: aff.rendezvous_id });
    } else if ((intro.state === "DECLINED" || intro.state === "EXPIRED") && !b.outcome_sent_at) {
      await pool.query("update briefings set consent_state = case when consent_state = 'PENDING' then 'CLOSED' else consent_state end, outcome_sent_at = now() where briefing_id = $1", [b.briefing_id]);
      if (mailEnabled()) await sendMail({ kind: "no_introduction", to: iv.email, ...noIntroductionEmail({ firstName: iv.first_name }) });
      await record(iv.interview_id, "no_introduction", { rendezvous_id: aff.rendezvous_id });
    }
  }

  // 3. Rendezvous that need our move. Bounded: at most N replies from our side per rendezvous, then we must recommend.
  for (const r of status.rendezvous ?? []) {
    if (r.action_needed !== "respond" && r.action_needed !== "submit_recommendation") continue;
    if (budget.calls <= 0) break;
    const read = await networkCall("rendezvous_read", { participant_secret: secret, rendezvous_id: r.rendezvous_id, limit: 200 });
    if (read.state !== "OPEN") continue;
    const mustRecommend = r.action_needed === "submit_recommendation" || (read.messages_from_you ?? 0) >= config.representative.maxRepliesPerRendezvous;
    if (mustRecommend && read.recommendation?.yours_submitted) continue;
    budget.calls--;
    await conductInvestigation(iv, secret, read, mustRecommend);
  }
}

export async function cycle(): Promise<{ people: number; model_calls: number; errors: number }> {
  if (!config.ambassador.anthropicApiKey) { log({ level: "warn", msg: "representative: no model key; skipping" }); return { people: 0, model_calls: 0, errors: 0 }; }
  const used = await modelCallsToday();
  const budget = { calls: Math.max(0, Math.min(config.representative.maxModelCallsPerCycle, config.representative.dailyModelCallCap - used)) };
  const start = budget.calls;
  const people = await pool.query("select * from interviews where status = 'paid' and intent_json is not null order by coalesce(network_joined_at, paid_at) asc limit 25");
  let errors = 0;
  for (const iv of people.rows as Interview[]) {
    try { await cycleOne(iv, budget); }
    catch (e) { errors++; log({ level: "error", msg: "representative cycle failed", interview: iv.interview_id, error: (e as Error).message }); await record(iv.interview_id, "error", { error: (e as Error).message.slice(0, 300) }); }
  }
  const out = { people: people.rowCount ?? 0, model_calls: start - budget.calls, errors };
  log({ msg: "representative cycle", ...out });
  return out;
}

export async function representativeView() {
  const counts = await pool.query("select kind, count(*)::int as n from representative_actions where at > now() - interval '7 days' group by kind");
  const people = await pool.query("select count(*)::int as n from interviews where status = 'paid'");
  const briefings = await pool.query("select consent_state, count(*)::int as n from briefings group by consent_state");
  const recent = await pool.query("select interview_id, kind, detail, at from representative_actions order by at desc limit 50");
  return { enabled: config.representative.enabled, every_minutes: config.representative.intervalMinutes, model: config.interview.model, represented_people: people.rows[0].n,
    limits: { max_model_calls_per_cycle: config.representative.maxModelCallsPerCycle, daily_model_call_cap: config.representative.dailyModelCallCap, max_replies_per_rendezvous: config.representative.maxRepliesPerRendezvous },
    model_calls_today: await modelCallsToday(), actions_7d: Object.fromEntries(counts.rows.map((r) => [r.kind, r.n])), briefings: Object.fromEntries(briefings.rows.map((r) => [r.consent_state, r.n])), recent: recent.rows };
}

// ---- consent: the person answers on a page; the representative carries the answer to the network ----
export async function briefingByToken(token: string) {
  if (!/^ic_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const r = await pool.query("select b.*, i.first_name, i.network_secret from briefings b join interviews i on i.interview_id = b.interview_id where b.token_hash = $1", [hashToken(token)]);
  return r.rows[0] ?? null;
}

export async function decideIntroduction(token: string, yes: boolean, contact: string): Promise<{ ok: true; state: string; counterpart_contact?: string | null } | { ok: false; error: string }> {
  const b = await briefingByToken(token);
  if (!b) return { ok: false, error: "This link isn't valid." };
  if (b.consent_state !== "PENDING") return { ok: true, state: b.consent_state, counterpart_contact: b.counterpart_contact };
  try {
    const res = yes
      ? await networkCall("introduction", { participant_secret: b.network_secret, rendezvous_id: b.rendezvous_id, action: "accept", human_confirmed: true, contact })
      : await networkCall("introduction", { participant_secret: b.network_secret, rendezvous_id: b.rendezvous_id, action: "decline" });
    if (res.state === "EXPIRED") { await pool.query("update briefings set consent_state = 'EXPIRED', decided_at = now() where briefing_id = $1", [b.briefing_id]); return { ok: true, state: "EXPIRED" }; }
    if (!yes) { await pool.query("update briefings set consent_state = 'NO', decided_at = now() where briefing_id = $1", [b.briefing_id]); await record(b.interview_id, "consent_no", { rendezvous_id: b.rendezvous_id }); return { ok: true, state: "NO" }; }
    const revealed = res.state === "REVEALED";
    await pool.query("update briefings set consent_state = $2, contact_shared = $3, counterpart_contact = $4, decided_at = now(), outcome_sent_at = case when $2 = 'REVEALED' then now() else outcome_sent_at end where briefing_id = $1",
      [b.briefing_id, revealed ? "REVEALED" : "YES", contact, revealed ? res.counterparty_contact ?? null : null]);
    await record(b.interview_id, "consent_yes", { rendezvous_id: b.rendezvous_id, revealed });
    if (revealed && mailEnabled()) { const iv = await pool.query("select email, first_name from interviews where interview_id = $1", [b.interview_id]); await sendMail({ kind: "reveal", to: iv.rows[0].email, ...revealEmail({ firstName: iv.rows[0].first_name, contact: String(res.counterparty_contact ?? ""), url: consentUrl(token) }) }); }
    return { ok: true, state: revealed ? "REVEALED" : "YES", counterpart_contact: revealed ? res.counterparty_contact ?? null : null };
  } catch (e) {
    log({ level: "error", msg: "consent relay failed", error: (e as Error).message });
    return { ok: false, error: "We couldn't record that just now. Nothing was shared. Please try again in a moment." };
  }
}

/** Operator: list briefings, and re-issue a consent link (tokens are hashed; while mail is sandboxed this is how the link reaches the person). */
export async function briefingsView() {
  const r = await pool.query("select b.briefing_id, b.interview_id, b.rendezvous_id, b.consent_state, b.created_at, b.mail_sent_at, b.decided_at, b.outcome_sent_at, i.email from briefings b join interviews i on i.interview_id = b.interview_id order by b.created_at desc limit 200");
  return r.rows;
}
export async function reissueConsentLink(briefingId: string, email: boolean): Promise<{ url: string; mail_sent: boolean } | null> {
  const b = await pool.query("select b.briefing_id, b.consent_state, i.email, i.first_name from briefings b join interviews i on i.interview_id = b.interview_id where b.briefing_id = $1", [briefingId]);
  if (!b.rowCount || b.rows[0].consent_state !== "PENDING") return null;
  const token = `ic_${randomBytes(24).toString("base64url")}`;
  await pool.query("update briefings set token_hash = $2 where briefing_id = $1", [briefingId, hashToken(token)]);
  const url = consentUrl(token);
  const mail = email && mailEnabled() ? await sendMail({ kind: "briefing", to: b.rows[0].email, ...briefingEmail({ firstName: b.rows[0].first_name, url }) }) : { sent: false };
  if (mail.sent) await pool.query("update briefings set mail_sent_at = now() where briefing_id = $1", [briefingId]);
  return { url, mail_sent: mail.sent };
}
