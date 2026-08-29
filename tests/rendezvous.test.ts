/**
 * End-to-end protocol test against a running server (default http://127.0.0.1:8080).
 * Requires OPERATOR_TOKEN (memberships are comped through the operator API).
 * Run: BASE_URL=http://127.0.0.1:8080 OPERATOR_TOKEN=... npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const MCP = `${BASE}/mcp`;
const TOKEN = process.env.OPERATOR_TOKEN;
if (!TOKEN) throw new Error("OPERATOR_TOKEN is required (used to comp memberships)");
const admin = (path: string, init: RequestInit = {}) => fetch(BASE + "/admin" + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) } });

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "rendezvous-test", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await client.callTool({ name, arguments: args });
  const data = r.structuredContent ?? JSON.parse(r.content[0].text);
  return { ...data, __isError: Boolean(r.isError) };
}

const region = `Test Region ${Date.now()}`; // isolate this run's participants from any others in the DB
const man = { represented_gender: "man", seeking_gender: ["woman"], represented_age_band: "50-59", preferred_age_min: 45, preferred_age_max: 60, relationship_intent: ["long_term"], region };
const woman = { represented_gender: "woman", seeking_gender: ["man"], represented_age_band: "45-49", preferred_age_min: 45, preferred_age_max: 65, relationship_intent: ["long_term", "marriage"], region };

let client: Client;
const P: Record<string, { id: string; secret: string }> = {};
async function joinAs(key: string, intent: object, member = true) {
  const j = await call(client, "join", { intent, client: { name: `test-${key}` } });
  assert.match(j.participant_secret, /^rv_live_/);
  P[key] = { id: j.participant_id, secret: j.participant_secret };
  if (member) {
    const r = await admin(`/participants/${j.participant_id}/membership`, { method: "POST", body: JSON.stringify({ action: "grant", reason: "test" }) });
    assert.equal(r.status, 200, "comp membership");
  }
  return P[key];
}

before(async () => { client = await connect(); });
after(async () => {
  // Leave no synthetic participants behind on a live network (PURGE_AFTER=1).
  if (process.env.PURGE_AFTER === "1") {
    for (const p of Object.values(P)) {
      const r = await admin(`/participants/${p.id}/purge`, { method: "POST" });
      assert.equal(r.status, 200, `purge ${p.id}`);
    }
  }
  await client.close();
});

test("protocol tool returns RAP/0.2 and server exposes instructions", async () => {
  const r = await call(client, "protocol");
  assert.equal(r.version, "RAP/0.2");
  assert.match(r.protocol, /A Rendezvous agent serves its human/);
  assert.match(r.protocol, /Membership and invitations/);
  assert.match(client.getInstructions() ?? "", /Rejection is a successful outcome/);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 14);
});

test("join creates identities; comp grants membership; resume works; bad secrets rejected", async () => {
  await joinAs("A", man);
  await joinAs("B", woman);
  await joinAs("C", { ...woman, region: "Elsewhere " + Date.now() });
  const sA = await call(client, "status", { participant_secret: P.A.secret });
  assert.equal(sA.membership.active, true);
  assert.equal(sA.membership.status, "comped");

  const resumed = await call(client, "join", { participant_secret: P.A.secret });
  assert.equal(resumed.trust_status, "RESUMED");
  assert.equal(resumed.participant_id, P.A.id);
  assert.equal(resumed.participant_secret, undefined);

  const bad = await call(client, "status", { participant_secret: "rv_live_notarealsecretnotarealsecret" });
  assert.equal(bad.error, "INVALID_SECRET");
  const none = await call(client, "status", {});
  assert.equal(none.error, "UNAUTHENTICATED");
  const badIntent = await call(client, "join", { intent: { ...man, represented_age_band: "15-17" } });
  assert.equal(badIntent.error, "INVALID_INPUT");
});

test("bearer header authentication works", async () => {
  const c2 = await connect({ Authorization: `Bearer ${P.A.secret}` });
  const s = await call(c2, "status");
  assert.equal(s.participant_id, P.A.id);
  await c2.close();
});

test("discover applies mutual hard eligibility", async () => {
  const s = await call(client, "status", { participant_secret: P.A.secret });
  assert.equal(s.new_candidates, 1);
  const d = await call(client, "discover", { participant_secret: P.A.secret, limit: 5 });
  assert.deepEqual(d.candidates.map((c: any) => c.candidate_id), [P.B.id]);
  assert.equal(d.candidates[0].member, true);
  assert.equal(d.candidates[0].history.trust_state, "NEW");
  assert.equal(d.candidates[0].coarse_facts.represented_age_band, "45-49");
  const dc = await call(client, "discover", { participant_secret: P.C.secret });
  assert.equal(dc.candidates.length, 0);
});

let rvz: string;
test("rendezvous: open, turn-taking, phases, disclosure prohibition", async () => {
  const o = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: P.B.id });
  assert.match(o.rendezvous_id, /^rvz_/);
  assert.equal(o.phase, "SCREEN");
  assert.equal(o.kind, "rendezvous");
  rvz = o.rendezvous_id;
  const again = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: P.B.id });
  assert.equal(again.existing, true);
  assert.equal(again.rendezvous_id, rvz);
  const notEligible = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: P.C.id });
  assert.equal(notEligible.error, "NOT_MUTUALLY_ELIGIBLE");

  for (let i = 1; i <= 3; i++) {
    const s = await call(client, "rendezvous_send", { participant_secret: P.A.secret, rendezvous_id: rvz, message: `A${i}: my human prefers quiet evenings.`,
      claims: [{ claim: "prefers quiet evenings", basis: "OBSERVED", confidence: 0.8 }] });
    assert.equal(s.sequence, i);
  }
  const fourth = await call(client, "rendezvous_send", { participant_secret: P.A.secret, rendezvous_id: rvz, message: "A4" });
  assert.equal(fourth.error, "WAITING_FOR_COUNTERPARTY");

  const leak = await call(client, "rendezvous_send", { participant_secret: P.B.secret, rendezvous_id: rvz, message: "reach her at jane@example.com" });
  assert.equal(leak.error, "DISCLOSURE_PROHIBITED");
  const phone = await call(client, "rendezvous_send", { participant_secret: P.B.secret, rendezvous_id: rvz, message: "call 561-555-0123 anytime" });
  assert.equal(phone.error, "DISCLOSURE_PROHIBITED");

  const rb = await call(client, "rendezvous_read", { participant_secret: P.B.secret, rendezvous_id: rvz });
  assert.equal(rb.messages.length, 3);
  assert.equal(rb.messages[0].from, "counterparty");
  assert.equal(rb.messages[0].new, true);
  assert.equal(rb.messages[0].claims[0].basis, "OBSERVED");
  assert.equal(rb.your_turn, true);
  assert.equal(rb.membership_required_to_respond, false);
  assert.equal(rb.counterparty.participant_id, P.A.id);

  let last: any;
  for (let i = 1; i <= 3; i++) last = await call(client, "rendezvous_send", { participant_secret: P.B.secret, rendezvous_id: rvz, message: `B${i}` });
  assert.equal(last.phase, "DEEP");
  assert.equal(last.phase_changed, true);

  const rb2 = await call(client, "rendezvous_read", { participant_secret: P.B.secret, rendezvous_id: rvz, after_sequence: 3 });
  assert.deepEqual(rb2.messages.map((m: any) => m.sequence), [4, 5, 6]);
  assert.equal(rb2.messages.every((m: any) => m.new === false), true);

  const stranger = await call(client, "rendezvous_read", { participant_secret: P.C.secret, rendezvous_id: rvz });
  assert.equal(stranger.error, "NOT_FOUND");
});

test("recommendations are sealed, immutable, and YES+YES => MUTUAL_AFFINITY", async () => {
  const noConcern = await call(client, "recommend", { participant_secret: P.A.secret, rendezvous_id: rvz, recommend: true, strengths: ["temperament"] });
  assert.equal(noConcern.error, "INVALID_INPUT");
  const a = await call(client, "recommend", { participant_secret: P.A.secret, rendezvous_id: rvz, recommend: true, confidence: 0.8, strengths: ["temperament"], concerns: ["relocation unknown"] });
  assert.equal(a.status, "AWAITING_COUNTERPARTY");
  const dup = await call(client, "recommend", { participant_secret: P.A.secret, rendezvous_id: rvz, recommend: false });
  assert.equal(dup.error, "CONFLICT");

  const rb = await call(client, "rendezvous_read", { participant_secret: P.B.secret, rendezvous_id: rvz });
  assert.equal(rb.phase, "DECIDING");
  assert.equal(rb.recommendation.counterparty_submitted, true);
  assert.equal(rb.recommendation.awaiting, "you");
  assert.equal(JSON.stringify(rb).includes("relocation"), false, "counterparty recommendation content must never leak");
  const sb = await call(client, "status", { participant_secret: P.B.secret });
  assert.equal(sb.recommendation_requests, 1);
  assert.equal(sb.suggested_next_step, "recommend");

  const b = await call(client, "recommend", { participant_secret: P.B.secret, rendezvous_id: rvz, recommend: true, concerns: ["pace"] });
  assert.equal(b.status, "MUTUAL_AFFINITY");
  const sa = await call(client, "status", { participant_secret: P.A.secret });
  assert.equal(sa.mutual_affinities.length, 1);
  assert.equal(sa.mutual_affinities[0].counterparty_id, P.B.id);
  assert.equal(sa.open_rendezvous, 0);
  const closedSend = await call(client, "rendezvous_send", { participant_secret: P.A.secret, rendezvous_id: rvz, message: "x" });
  assert.equal(closedSend.error, "RENDEZVOUS_CLOSED");
});

test("counterparty assessment feeds trust evidence, not compatibility", async () => {
  const r = await call(client, "assess_counterparty", { participant_secret: P.A.secret, rendezvous_id: rvz, good_faith: true, responsive: true, appears_to_represent_a_human: "likely" });
  assert.equal(r.recorded, true);
  const dup = await call(client, "assess_counterparty", { participant_secret: P.A.secret, rendezvous_id: rvz, good_faith: true });
  assert.equal(dup.error, "CONFLICT");
  const sb = await call(client, "status", { participant_secret: P.B.secret });
  assert.equal(sb.history.good_faith_attestations, 1);
  assert.equal(sb.history.rendezvous_completed, 1);
  assert.equal(sb.history.unique_counterparties, 1);
});

test("NO recommendation never leaks, and a YES needs a real investigation", async () => {
  await joinAs("D", woman);
  const o = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: P.D.id });
  await call(client, "rendezvous_send", { participant_secret: P.A.secret, rendezvous_id: o.rendezvous_id, message: "hello" });
  await call(client, "rendezvous_send", { participant_secret: P.D.secret, rendezvous_id: o.rendezvous_id, message: "hello back" });
  const no = await call(client, "recommend", { participant_secret: P.D.secret, rendezvous_id: o.rendezvous_id, recommend: false });
  assert.equal(no.status, "AWAITING_COUNTERPARTY");
  const ra = await call(client, "rendezvous_read", { participant_secret: P.A.secret, rendezvous_id: o.rendezvous_id });
  assert.equal(ra.state, "OPEN");
  assert.equal(ra.recommendation.awaiting, "you");
  const tooEarlyYes = await call(client, "recommend", { participant_secret: P.A.secret, rendezvous_id: o.rendezvous_id, recommend: true, concerns: ["x"] });
  assert.equal(tooEarlyYes.error, "INVALID_INPUT");
  const done = await call(client, "recommend", { participant_secret: P.A.secret, rendezvous_id: o.rendezvous_id, recommend: false });
  assert.equal(done.status, "NO_INTRODUCTION");
  const reopen = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: P.D.id });
  assert.equal(reopen.error, "CONFLICT");
});

test("close is neutral to the counterparty", async () => {
  await joinAs("E", woman);
  const o = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: P.E.id });
  const c = await call(client, "rendezvous_close", { participant_secret: P.A.secret, rendezvous_id: o.rendezvous_id, reason: "incompatible", note: "private" });
  assert.equal(c.outcome, "NO_INTRODUCTION");
  assert.equal(c.closed_by_you, true);
  const re = await call(client, "rendezvous_read", { participant_secret: P.E.secret, rendezvous_id: o.rendezvous_id });
  assert.equal(re.outcome, "NO_INTRODUCTION");
  assert.equal(re.closed_by_you, false);
  assert.equal(JSON.stringify(re).includes("incompatible"), false);
  assert.equal(JSON.stringify(re).includes("private"), false);
});

test("membership: non-members watch for free, read invitations in full, decline free, and can only talk once a member", async () => {
  const g = await joinAs("G", woman, false); // registered, not a member
  const sg = await call(client, "status", { participant_secret: g.secret });
  assert.equal(sg.membership.active, false);
  assert.equal(sg.eligible_members, 1, "A is the only eligible member for G (B, D, E are in concluded rendezvous with A or ineligible)");
  assert.equal(sg.new_candidates, undefined);
  const dg = await call(client, "discover", { participant_secret: g.secret });
  assert.equal(dg.membership_required, true);
  assert.equal(dg.eligible_members, 1);
  assert.deepEqual(dg.candidates, []);
  for (const [tool, args] of [["rendezvous_send", { rendezvous_id: "rvz_x", message: "hi" }], ["recommend", { rendezvous_id: "rvz_x", recommend: false }], ["assess_counterparty", { rendezvous_id: "rvz_x", good_faith: true }]] as const) {
    const r = await call(client, tool, { participant_secret: g.secret, ...args });
    assert.equal(r.error, "MEMBERSHIP_REQUIRED", tool);
  }

  // A (member) sees G flagged as a non-member, and must include an opening message to invite.
  const da = await call(client, "discover", { participant_secret: P.A.secret, limit: 10 });
  const gc = da.candidates.find((c: any) => c.candidate_id === g.id);
  assert.ok(gc, "G is discoverable to members");
  assert.equal(gc.member, false);
  const noMsg = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: g.id });
  assert.equal(noMsg.error, "INVALID_INPUT");
  const before = await call(client, "status", { participant_secret: P.A.secret });
  const inv = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: g.id, message: "My human is a 54-year-old sailor who cooks and reads history; quiet weeknights, boat on weekends. Is your human's week anything like that?",
    claims: [{ claim: "sails most weekends", basis: "EXPLICIT", confidence: 1 }] });
  assert.equal(inv.kind, "invitation");
  assert.ok(inv.invitation.expires_at);
  assert.equal(inv.opening_message.sequence, 1);
  const afterA = await call(client, "status", { participant_secret: P.A.secret });
  assert.equal(afterA.open_rendezvous, before.open_rendezvous, "invitations do not count against the sender's cap");
  assert.equal(afterA.invitations_sent.length, 1);

  // G's agent sees the whole thing: who, what they wrote, their history — and can decline for free.
  const sg2 = await call(client, "status", { participant_secret: g.secret });
  assert.equal(sg2.invitations.length, 1);
  assert.match(sg2.invitations[0].message, /54-year-old sailor/);
  assert.equal(sg2.invitations[0].claims[0].basis, "EXPLICIT");
  assert.equal(sg2.invitations[0].from.participant_id, P.A.id);
  assert.match(sg2.suggested_next_step, /Relay each invitation/);
  const rg = await call(client, "rendezvous_read", { participant_secret: g.secret, rendezvous_id: inv.rendezvous_id });
  assert.equal(rg.kind, "invitation");
  assert.equal(rg.membership_required_to_respond, true);
  assert.equal(rg.messages.length, 1);
  assert.match(rg.messages[0].message, /sailor/);
  const reply = await call(client, "rendezvous_send", { participant_secret: g.secret, rendezvous_id: inv.rendezvous_id, message: "hi" });
  assert.equal(reply.error, "MEMBERSHIP_REQUIRED");
  const rec = await call(client, "recommend", { participant_secret: P.A.secret, rendezvous_id: inv.rendezvous_id, recommend: false });
  assert.equal(rec.error, "INVALID_INPUT", "no recommendation on an unanswered invitation");

  // G becomes a member (comped here; Stripe in production) and replies: the invitation becomes a rendezvous for both.
  const grant = await admin(`/participants/${g.id}/membership`, { method: "POST", body: JSON.stringify({ action: "grant" }) });
  assert.equal(grant.status, 200);
  const r2 = await call(client, "rendezvous_send", { participant_secret: g.secret, rendezvous_id: inv.rendezvous_id, message: "Quiet weeknights, yes; weekends on the water, absolutely." });
  assert.equal(r2.invitation_accepted, true);
  assert.equal(r2.kind, "rendezvous");
  const afterA2 = await call(client, "status", { participant_secret: P.A.secret });
  assert.equal(afterA2.open_rendezvous, before.open_rendezvous + 1);
  assert.equal(afterA2.invitations_sent.length, 0);
  const sg3 = await call(client, "status", { participant_secret: g.secret });
  assert.equal(sg3.open_rendezvous, 1);
  assert.equal(sg3.invitations.length, 0);

  // A second invitation to a fresh non-member can be declined for free.
  const h = await joinAs("H", woman, false);
  const inv2 = await call(client, "rendezvous_open", { participant_secret: P.A.secret, candidate_id: h.id, message: "Opening line for H." });
  assert.equal(inv2.kind, "invitation");
  const dec = await call(client, "rendezvous_close", { participant_secret: h.secret, rendezvous_id: inv2.rendezvous_id, reason: "decline" });
  assert.equal(dec.outcome, "NO_INTRODUCTION");
  const ra = await call(client, "rendezvous_read", { participant_secret: P.A.secret, rendezvous_id: inv2.rendezvous_id });
  assert.equal(ra.outcome, "NO_INTRODUCTION");
  assert.equal(ra.closed_by_you, false);
});

test("block hides both directions; report creates a record", async () => {
  await joinAs("F", woman);
  const before = await call(client, "discover", { participant_secret: P.A.secret, limit: 10 });
  assert.ok(before.candidates.some((c: any) => c.candidate_id === P.F.id));
  const b = await call(client, "block", { participant_secret: P.A.secret, subject_id: P.F.id });
  assert.equal(b.blocked, true);
  const afterBlock = await call(client, "discover", { participant_secret: P.A.secret, limit: 10 });
  assert.ok(!afterBlock.candidates.some((c: any) => c.candidate_id === P.F.id));
  const fromF = await call(client, "discover", { participant_secret: P.F.secret, limit: 10 });
  assert.ok(!fromF.candidates.some((c: any) => c.candidate_id === P.A.id));
  const open = await call(client, "rendezvous_open", { participant_secret: P.F.secret, candidate_id: P.A.id });
  assert.equal(open.error, "NOT_MUTUALLY_ELIGIBLE");
  const rp = await call(client, "report", { participant_secret: P.A.secret, subject_id: P.F.id, reason: "spam", details: "test report" });
  assert.match(rp.report_id, /^rpt_/);
  const sf = await call(client, "status", { participant_secret: P.F.secret });
  assert.equal(sf.history.reports_received, 1);
  assert.equal(sf.history.blocks_received, 1);
});

test("withdraw and rejoin (membership survives; collection would pause/resume)", async () => {
  const w = await call(client, "withdraw", { participant_secret: P.E.secret, reason: "done" });
  assert.equal(w.withdrawn, true);
  const s = await call(client, "status", { participant_secret: P.E.secret });
  assert.equal(s.error, "PARTICIPANT_WITHDRAWN");
  const j = await call(client, "join", { participant_secret: P.E.secret });
  assert.equal(j.trust_status, "RESUMED");
  const s2 = await call(client, "status", { participant_secret: P.E.secret });
  assert.equal(s2.active, false, "intent was deactivated on withdraw");
  assert.equal(s2.membership.active, true, "a comped membership is untouched by withdraw");
  const j2 = await call(client, "join", { participant_secret: P.E.secret, intent: woman });
  assert.equal(j2.intent.region, region);
});

test("billing: status is honest; Stripe webhook (incl. payment-link custom field) flips membership idempotently", async () => {
  const st = await call(client, "billing", { participant_secret: P.H.secret });
  assert.equal(st.membership.active, false);
  assert.match(st.founder_page, /\/founder$/);
  if (!st.billing_enabled) {
    const co = await call(client, "billing", { participant_secret: P.H.secret, action: "checkout" });
    assert.equal(co.error, "BILLING_UNAVAILABLE");
    return;
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) { assert.equal(st.membership.status, "none"); return; } // real keys on the server: don't create Stripe objects from a verification run
  const co = await call(client, "billing", { participant_secret: P.H.secret, action: "checkout" });
  assert.equal(co.error, "BILLING_ERROR"); // dummy key → typed error, never INTERNAL
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe("sk_test_dummy");
  const post = async (payload: object, sig?: string) => {
    const body = JSON.stringify(payload);
    const header = sig ?? stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    return fetch(BASE + "/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body });
  };
  const evt = (id: string, type: string, object: object) => ({ id, object: "event", type, api_version: "2025-01-01", created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 0, request: null, data: { object } });
  const bad = await post(evt("evt_bad", "checkout.session.completed", {}), "t=1,v1=deadbeef");
  assert.equal(bad.status, 400);
  // Payment-link purchase: participant only in the custom field.
  const ok = await post(evt("evt_" + Date.now(), "checkout.session.completed", { id: "cs_test_1", object: "checkout.session", mode: "subscription", customer: "cus_test_" + P.H.id, subscription: "sub_test_1", client_reference_id: null, metadata: {}, custom_fields: [{ key: "participant_id", type: "text", text: { value: " " + P.H.id + " " } }] }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).applied, true);
  const m = await call(client, "billing", { participant_secret: P.H.secret });
  assert.equal(m.membership.active, true);
  assert.equal(m.membership.status, "active");
  const talk = await call(client, "discover", { participant_secret: P.H.secret });
  assert.equal(talk.membership_required, undefined);
  const dupId = "evt_dup_" + Date.now();
  const first = await post(evt(dupId, "customer.subscription.updated", { id: "sub_test_1", object: "subscription", status: "active", pause_collection: { behavior: "void" }, customer: "cus_test_" + P.H.id, metadata: { participant_id: P.H.id }, items: { data: [{ price: { id: "price_dummy" } }] } }));
  assert.equal((await first.json()).duplicate, false);
  const again = await post(evt(dupId, "customer.subscription.updated", { id: "sub_test_1", object: "subscription", status: "active", pause_collection: { behavior: "void" }, customer: "cus_test_" + P.H.id, metadata: { participant_id: P.H.id } }));
  assert.equal((await again.json()).duplicate, true);
  const paused = await call(client, "billing", { participant_secret: P.H.secret });
  assert.equal(paused.membership.status, "paused");
  assert.equal(paused.membership.active, false);
  const resumed = await post(evt("evt_res_" + Date.now(), "customer.subscription.updated", { id: "sub_test_1", object: "subscription", status: "active", pause_collection: null, customer: "cus_test_" + P.H.id, metadata: { participant_id: P.H.id }, items: { data: [{ price: { id: "price_dummy" } }] } }));
  assert.equal(resumed.status, 200);
  const back = await call(client, "billing", { participant_secret: P.H.secret });
  assert.equal(back.membership.active, true);
  assert.equal(back.membership.founding_member, true, "STRIPE_FOUNDER_PRICE_ID defaults to STRIPE_PRICE_ID");
  const del = await post(evt("evt_del_" + Date.now(), "customer.subscription.deleted", { id: "sub_test_1", object: "subscription", status: "canceled", customer: "cus_test_" + P.H.id, metadata: { participant_id: P.H.id } }));
  assert.equal(del.status, 200);
  const gone = await call(client, "billing", { participant_secret: P.H.secret });
  assert.equal(gone.membership.active, false);
  assert.equal(gone.membership.status, "canceled");
});

test("website, llms.txt, stats and operator API", async () => {
  for (const p of ["/", "/how-it-works", "/for-agents", "/trust", "/privacy", "/terms", "/protocol", "/stats", "/llms.txt", "/healthz", "/founder", "/billing/success", "/billing/cancel"]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
  }
  const home = await (await fetch(BASE + "/")).text();
  assert.match(home, /Let your AI[\s\S]*find it for you/);
  assert.match(home, /Everything below this line is for your AI/);
  assert.match(home, /Free to watch/);
  const unauth = await fetch(BASE + "/admin/stats");
  assert.equal(unauth.status, 401);
  const r = await admin("/stats");
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.ok(Number(s.mutual_affinities) >= 1);
  assert.ok(Number(s.members) >= 1);
  const reports = await (await admin("/reports")).json();
  assert.ok(reports.some((x: any) => x.subject_id === P.F.id));
  const dis = await admin(`/participants/${P.F.id}/disable`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
  assert.equal(dis.status, 200);
  const sf = await call(client, "status", { participant_secret: P.F.secret });
  assert.equal(sf.error, "PARTICIPANT_DISABLED");
  const mcpGet = await fetch(BASE + "/mcp");
  assert.equal(mcpGet.status, 405);
});
