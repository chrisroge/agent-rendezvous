import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { safeEqual } from "../participants/ids.js";
import { trustEvent } from "../participants/service.js";
import * as ambassador from "../ambassador/run.js";
import { funnel } from "../telemetry.js";

/** Operator API. Bearer OPERATOR_TOKEN. Kill switches: disable participant, close rendezvous, pause network. */
export const admin = Router();

admin.use((req: Request, res: Response, next: NextFunction) => {
  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!config.operatorToken || !token || !safeEqual(token, config.operatorToken)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

admin.get("/stats", async (_req, res) => {
  const r = await pool.query(`select
    (select count(*) from participants) as participants_total,
    (select count(*) from participants where status = 'active') as participants_active,
    (select count(*) from participants where status = 'active' and plan = 'member' and plan_status in ('active','past_due','comped')) as members,
    (select count(*) from participants where plan_status = 'comped') as members_comped,
    (select count(*) from rendezvous where state = 'OPEN' and kind = 'invitation') as invitations_pending,
    (select count(*) from participants where last_seen_at > created_at + interval '1 day') as participants_returning,
    (select count(*) from match_intents where active) as intents_active,
    (select count(*) from rendezvous) as rendezvous_opened,
    (select count(*) from rendezvous where state = 'OPEN') as rendezvous_open,
    (select count(*) from rendezvous where state = 'CLOSED' and outcome in ('MUTUAL_AFFINITY','NO_INTRODUCTION','DECLINED') and message_count >= 2) as rendezvous_completed,
    (select count(*) from rendezvous where outcome = 'MUTUAL_AFFINITY') as mutual_affinities,
    (select count(*) from recommendations) as recommendations,
    (select count(*) from recommendations where recommend) as recommendations_yes,
    (select count(*) from messages) as messages,
    (select coalesce(avg(message_count),0)::numeric(10,1) from rendezvous where state = 'CLOSED') as avg_messages_per_closed_rendezvous,
    (select count(*) from counterparty_assessments) as assessments,
    (select count(*) from blocks) as blocks,
    (select count(*) from reports) as reports,
    (select count(*) from reports where review_state = 'open') as reports_open,
    (select count(*) from (select participant_id from participant_activity_days group by 1 having count(*) > 7) x) as participants_over_7_active_days,
    (select value from settings where key = 'network_paused') as network_paused`);
  res.json(r.rows[0]);
});

admin.get("/reports", async (req, res) => {
  const state = String(req.query.state ?? "open");
  const r = await pool.query("select * from reports where review_state = $1 order by created_at desc limit 200", [state]);
  res.json(r.rows);
});

admin.post("/reports/:id", async (req, res) => {
  const { review_state, notes } = req.body ?? {};
  if (!["open", "reviewed", "actioned", "dismissed"].includes(review_state)) { res.status(400).json({ error: "bad review_state" }); return; }
  const r = await pool.query("update reports set review_state = $2, review_notes = $3, reviewed_at = now() where report_id = $1 returning *", [req.params.id, review_state, notes ?? null]);
  res.json(r.rows[0] ?? { error: "not found" });
});

admin.get("/participants", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  const r = await pool.query(
    `select p.participant_id, p.status, p.created_at, p.last_seen_at, p.client_info, i.region, i.represented_gender,
            (select count(*)::int from rendezvous r where r.participant_a = p.participant_id or r.participant_b = p.participant_id) as rendezvous
       from participants p left join match_intents i on i.participant_id = p.participant_id and i.active
      order by p.created_at desc limit $1`, [limit]);
  res.json(r.rows);
});

/** Hard delete: honours a deletion request (privacy policy) and removes synthetic/test participants. Irreversible. */
admin.post("/participants/:id/purge", async (req, res) => {
  const id = req.params.id;
  const exists = await pool.query("select 1 from participants where participant_id = $1", [id]);
  if (!exists.rowCount) { res.status(404).json({ error: "not found" }); return; }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const rvz = await client.query("delete from rendezvous where participant_a = $1 or participant_b = $1 returning rendezvous_id", [id]);
    await client.query("delete from blocks where blocker_id = $1 or blocked_id = $1", [id]);
    await client.query("delete from reports where reporter_id = $1 or subject_id = $1", [id]);
    await client.query("delete from counterparty_assessments where assessor_id = $1 or subject_id = $1", [id]);
    await client.query("delete from trust_events where participant_id = $1 or source_participant_id = $1", [id]);
    await client.query("delete from audit_log where participant_id = $1", [id]);
    await client.query("delete from participants where participant_id = $1", [id]);
    await client.query("commit");
    res.json({ purged: true, participant_id: id, rendezvous_deleted: rvz.rowCount });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    res.status(500).json({ error: (e as Error).message });
  } finally {
    client.release();
  }
});

admin.get("/participants/:id", async (req, res) => {
  const id = req.params.id;
  const p = await pool.query("select participant_id, status, created_at, last_seen_at, disabled_at, disabled_reason, client_info, plan, plan_status, plan_updated_at, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_checkout_session_id, stripe_checkout_expires_at from participants where participant_id = $1", [id]);
  if (!p.rows[0]) { res.status(404).json({ error: "not found" }); return; }
  const [intent, rvz, events, reports] = await Promise.all([
    pool.query("select * from match_intents where participant_id = $1 and active", [id]),
    pool.query("select rendezvous_id, participant_a, participant_b, state, phase, outcome, message_count, created_at, closed_at from rendezvous where participant_a = $1 or participant_b = $1 order by created_at desc limit 50", [id]),
    pool.query("select event_type, source_participant_id, rendezvous_id, metadata, created_at from trust_events where participant_id = $1 order by created_at desc limit 100", [id]),
    pool.query("select * from reports where subject_id = $1 or reporter_id = $1 order by created_at desc", [id]),
  ]);
  res.json({ participant: p.rows[0], intent: intent.rows[0] ?? null, rendezvous: rvz.rows, trust_events: events.rows, reports: reports.rows });
});

admin.post("/participants/:id/disable", async (req, res) => {
  const id = req.params.id, reason = String(req.body?.reason ?? "operator");
  await pool.query("update participants set status = 'disabled', disabled_at = now(), disabled_reason = $2 where participant_id = $1", [id, reason]);
  await pool.query("update match_intents set active = false where participant_id = $1", [id]);
  const closed = await pool.query("update rendezvous set state = 'CLOSED', phase = 'CLOSED', outcome = 'OPERATOR_CLOSED', closed_at = now(), updated_at = now() where state = 'OPEN' and (participant_a = $1 or participant_b = $1) returning rendezvous_id", [id]);
  await trustEvent(pool, id, "operator_disabled", { metadata: { reason } });
  res.json({ disabled: true, closed_rendezvous: closed.rowCount });
});

admin.post("/participants/:id/enable", async (req, res) => {
  await pool.query("update participants set status = 'active', disabled_at = null, disabled_reason = null where participant_id = $1 and status = 'disabled'", [req.params.id]);
  await trustEvent(pool, req.params.id, "operator_enabled");
  res.json({ enabled: true });
});

/** Operator comp: grant or revoke membership without Stripe (seed cohort, experiments, goodwill). */
admin.post("/participants/:id/membership", async (req, res) => {
  const action = String(req.body?.action ?? "");
  if (!["grant", "revoke"].includes(action)) { res.status(400).json({ error: "action must be grant or revoke" }); return; }
  const r = action === "grant"
    ? await pool.query("update participants set plan = 'member', plan_status = 'comped', plan_updated_at = now() where participant_id = $1 and plan_status <> 'active' returning plan, plan_status", [req.params.id])
    : await pool.query("update participants set plan = 'free', plan_status = 'none', plan_updated_at = now() where participant_id = $1 and plan_status = 'comped' returning plan, plan_status", [req.params.id]);
  if (!r.rowCount) { res.status(409).json({ error: action === "grant" ? "not found, or already a paying member" : "not found, or not a comped membership" }); return; }
  await trustEvent(pool, req.params.id, action === "grant" ? "membership_comped" : "membership_comp_revoked", { metadata: { reason: req.body?.reason ?? null } });
  res.json({ participant_id: req.params.id, ...r.rows[0] });
});

admin.get("/rendezvous/:id", async (req, res) => {
  const r = await pool.query("select * from rendezvous where rendezvous_id = $1", [req.params.id]);
  if (!r.rows[0]) { res.status(404).json({ error: "not found" }); return; }
  const [msgs, recs] = await Promise.all([
    pool.query("select sequence, sender_participant_id, content_json, created_at from messages where rendezvous_id = $1 order by sequence", [req.params.id]),
    pool.query("select participant_id, recommend, confidence, strengths_json, concerns_json, questions_json, submitted_at from recommendations where rendezvous_id = $1", [req.params.id]),
  ]);
  res.json({ rendezvous: r.rows[0], messages: msgs.rows, recommendations: recs.rows });
});

admin.post("/rendezvous/:id/close", async (req, res) => {
  const r = await pool.query("update rendezvous set state = 'CLOSED', phase = 'CLOSED', outcome = 'OPERATOR_CLOSED', closed_at = now(), updated_at = now() where rendezvous_id = $1 and state = 'OPEN' returning rendezvous_id", [req.params.id]);
  res.json({ closed: (r.rowCount ?? 0) > 0 });
});

admin.post("/network/pause", async (req, res) => {
  const paused = req.body?.paused === true;
  await pool.query("insert into settings(key, value, updated_at) values ('network_paused', $1, now()) on conflict (key) do update set value = excluded.value, updated_at = now()", [JSON.stringify(paused)]);
  res.json({ network_paused: paused });
});

admin.get("/billing/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const r = await pool.query("select event_id, event_type, participant_id, applied, received_at from billing_events order by received_at desc limit $1", [limit]);
  res.json(r.rows);
});

// ---- Moltbook ambassador (charter: docs/moltbook-ambassador-charter.md) ----
admin.get("/ambassador", async (_req, res) => { res.json(await ambassador.overview()); });
admin.post("/ambassador/register", async (req, res) => {
  const name = String(req.body?.name ?? "Rendezvous"), description = String(req.body?.description ?? "");
  if (!description) { res.status(400).json({ error: "description (the charter bio) is required" }); return; }
  try { res.json(await ambassador.register(name, description)); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});
admin.post("/ambassador/profile", async (req, res) => {
  const description = String(req.body?.description ?? ""); if (!description) { res.status(400).json({ error: "description required" }); return; }
  try { const { Moltbook } = await import("../ambassador/moltbook.js"); const mb = new Moltbook(await ambassador.getState<string>("api_key")); res.json(await mb.updateProfile(description)); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});
admin.get("/ambassador/moltbook-status", async (_req, res) => {
  try { const { Moltbook } = await import("../ambassador/moltbook.js"); const mb = new Moltbook(await ambassador.getState<string>("api_key")); res.json({ status: await mb.status(), me: await mb.me() }); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});
admin.get("/ambassador/submolts", async (req, res) => {
  try { const { Moltbook } = await import("../ambassador/moltbook.js"); const mb = new Moltbook(await ambassador.getState<string>("api_key"));
    const q = typeof req.query.q === "string" ? req.query.q : ""; res.json(q ? await mb.search(q, "posts", 15) : await mb.submolts()); }
  catch (e) { res.status(502).json({ error: (e as Error).message }); }
});
admin.post("/ambassador/seed-post", async (req, res) => {
  const submolt = String(req.body?.submolt ?? ""); if (!submolt) { res.status(400).json({ error: "submolt required" }); return; }
  try { res.json(await ambassador.seedReferencePost(submolt)); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
admin.post("/ambassador/drafts/:id/:decision", async (req, res) => {
  const decision = req.params.decision; if (!["approve", "reject"].includes(decision)) { res.status(400).json({ error: "decision must be approve or reject" }); return; }
  const body = typeof req.body?.body === "string" && req.body.body.trim() ? req.body.body.trim() : null; // founder may edit before approving
  if (body) {
    const { checkText } = await import("../ambassador/policy.js");
    const kind = (await pool.query("select kind from ambassador_drafts where draft_id = $1", [req.params.id])).rows[0]?.kind;
    if (!kind) { res.status(404).json({ error: "not found" }); return; }
    const c = checkText(body, kind); if (!c.ok) { res.status(400).json({ error: "edited text fails the filter", problems: c.problems }); return; }
  }
  const r = await pool.query(
    `update ambassador_drafts set status = $2, decided_at = now(), decided_by = 'founder', body = coalesce($3, body), mentions_rendezvous = case when $3 is null then mentions_rendezvous else ($3 ~* 'rendezvous') end
       where draft_id = $1 and status in ('pending','approved') returning draft_id, status, kind, target_post_id`,
    [req.params.id, decision === "approve" ? "approved" : "rejected", body]);
  if (!r.rowCount) { res.status(404).json({ error: "not found or already decided" }); return; }
  res.json(r.rows[0]);
});
admin.post("/ambassador/pause", async (req, res) => { const days = Number(req.body?.days ?? 14); res.json({ paused_until: await ambassador.pause(days, String(req.body?.reason ?? "founder")) }); });
admin.post("/ambassador/resume", async (_req, res) => { await ambassador.setState("paused_until", null); await ambassador.setState("challenge_failures", 0); res.json({ resumed: true }); });
admin.post("/ambassador/run", async (req, res) => {
  const action = String(req.body?.action ?? "cycle");
  try {
    if (action === "scan") res.json(await ambassador.scan());
    else if (action === "publish") res.json(await ambassador.publish());
    else res.json(await ambassador.cycle());
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});

admin.get("/telemetry", async (req, res) => { res.json(await funnel(Number(req.query.days ?? 7))); });

admin.get("/audit", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  const r = await pool.query("select * from audit_log order by audit_id desc limit $1", [limit]);
  res.json(r.rows);
});
