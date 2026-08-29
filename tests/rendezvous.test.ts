/**
 * End-to-end protocol test against a running server (default http://127.0.0.1:8080).
 * Run: BASE_URL=http://127.0.0.1:8080 OPERATOR_TOKEN=... npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const MCP = `${BASE}/mcp`;

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

before(async () => { client = await connect(); });
after(async () => {
  // Leave no synthetic participants behind on a live network (PURGE_AFTER=1 + OPERATOR_TOKEN).
  if (process.env.PURGE_AFTER === "1" && process.env.OPERATOR_TOKEN) {
    for (const p of Object.values(P)) {
      const r = await fetch(`${BASE}/admin/participants/${p.id}/purge`, { method: "POST", headers: { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` } });
      assert.equal(r.status, 200, `purge ${p.id}`);
    }
  }
  await client.close();
});

test("protocol tool returns RAP/0.1 and server exposes instructions", async () => {
  const r = await call(client, "protocol");
  assert.equal(r.version, "RAP/0.1");
  assert.match(r.protocol, /A Rendezvous agent serves its human/);
  assert.match(client.getInstructions() ?? "", /Rejection is a successful outcome/);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 14);
});

test("join creates identities; resume works; bad secrets rejected", async () => {
  const a = await call(client, "join", { intent: man, client: { name: "test-a" } });
  assert.equal(a.trust_status, "NEW");
  assert.match(a.participant_secret, /^rv_live_/);
  P.A = { id: a.participant_id, secret: a.participant_secret };
  const b = await call(client, "join", { intent: woman });
  P.B = { id: b.participant_id, secret: b.participant_secret };
  const c = await call(client, "join", { intent: { ...woman, region: "Elsewhere " + Date.now() } });
  P.C = { id: c.participant_id, secret: c.participant_secret };

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
  const d = await call(client, "join", { intent: woman });
  P.D = { id: d.participant_id, secret: d.participant_secret };
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
  const e = await call(client, "join", { intent: woman });
  P.E = { id: e.participant_id, secret: e.participant_secret };
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

test("block hides both directions; report creates a record", async () => {
  const f = await call(client, "join", { intent: woman });
  P.F = { id: f.participant_id, secret: f.participant_secret };
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

test("withdraw and rejoin", async () => {
  const w = await call(client, "withdraw", { participant_secret: P.E.secret, reason: "done" });
  assert.equal(w.withdrawn, true);
  const s = await call(client, "status", { participant_secret: P.E.secret });
  assert.equal(s.error, "PARTICIPANT_WITHDRAWN");
  const j = await call(client, "join", { participant_secret: P.E.secret });
  assert.equal(j.trust_status, "RESUMED");
  const s2 = await call(client, "status", { participant_secret: P.E.secret });
  assert.equal(s2.active, false, "intent was deactivated on withdraw");
  const j2 = await call(client, "join", { participant_secret: P.E.secret, intent: woman });
  assert.equal(j2.intent.region, region);
});

test("billing: free by default; Stripe webhook flips plan and limits idempotently", async () => {
  const st = await call(client, "billing", { participant_secret: P.A.secret });
  assert.equal(st.plan, "free");
  assert.ok(st.plus_would_give.max_active_rendezvous > st.limits.max_active_rendezvous);
  if (!st.billing_enabled) {
    const co = await call(client, "billing", { participant_secret: P.A.secret, action: "checkout" });
    assert.equal(co.error, "BILLING_UNAVAILABLE");
    return; // webhook path needs STRIPE_* configured on the server under test
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Real Stripe keys on the server (e.g. production) and no webhook secret for us to sign with:
    // don't create Stripe objects from a verification run; the disabled/enabled contract is checked above.
    assert.equal(st.plan_status, "none");
    return;
  }
  // Dummy keys: Stripe rejects the API call, and the agent must get a typed error, not INTERNAL.
  const co = await call(client, "billing", { participant_secret: P.A.secret, action: "checkout" });
  assert.equal(co.error, "BILLING_ERROR");
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
  const ok = await post(evt("evt_" + Date.now(), "checkout.session.completed", { id: "cs_test_1", object: "checkout.session", mode: "subscription", customer: "cus_test_" + P.A.id, subscription: "sub_test_1", client_reference_id: P.A.id, metadata: { participant_id: P.A.id } }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).applied, true);
  const plus = await call(client, "billing", { participant_secret: P.A.secret });
  assert.equal(plus.plan, "plus");
  assert.equal(plus.plan_status, "active");
  assert.equal(plus.limits.max_active_rendezvous, st.plus_would_give.max_active_rendezvous);
  const sA = await call(client, "status", { participant_secret: P.A.secret });
  assert.equal(sA.plan, "plus");
  const dupId = "evt_dup_" + Date.now();
  const first = await post(evt(dupId, "customer.subscription.updated", { id: "sub_test_1", object: "subscription", status: "past_due", customer: "cus_test_" + P.A.id, metadata: { participant_id: P.A.id } }));
  assert.equal((await first.json()).duplicate, false);
  const again = await post(evt(dupId, "customer.subscription.updated", { id: "sub_test_1", object: "subscription", status: "past_due", customer: "cus_test_" + P.A.id, metadata: { participant_id: P.A.id } }));
  assert.equal((await again.json()).duplicate, true);
  const pastDue = await call(client, "billing", { participant_secret: P.A.secret });
  assert.equal(pastDue.plan_status, "past_due");
  const del = await post(evt("evt_del_" + Date.now(), "customer.subscription.deleted", { id: "sub_test_1", object: "subscription", status: "canceled", customer: "cus_test_" + P.A.id, metadata: { participant_id: P.A.id } }));
  assert.equal(del.status, 200);
  const back = await call(client, "billing", { participant_secret: P.A.secret });
  assert.equal(back.plan, "free");
  assert.equal(back.plan_status, "canceled");
});

test("website, llms.txt, stats and operator API", async () => {
  for (const p of ["/", "/how-it-works", "/for-agents", "/trust", "/privacy", "/terms", "/protocol", "/stats", "/llms.txt", "/healthz", "/billing/success", "/billing/cancel"]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
  }
  const home = await (await fetch(BASE + "/")).text();
  assert.match(home, /Let your AI look for you/);
  assert.match(home, /Everything below this line is for your AI/);
  const unauth = await fetch(BASE + "/admin/stats");
  assert.equal(unauth.status, 401);
  if (process.env.OPERATOR_TOKEN) {
    const r = await fetch(BASE + "/admin/stats", { headers: { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` } });
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.ok(Number(s.mutual_affinities) >= 1);
    const reports = await (await fetch(BASE + "/admin/reports", { headers: { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` } })).json();
    assert.ok(reports.some((x: any) => x.subject_id === P.F.id));
    // kill switch: disable F, F can no longer act
    const dis = await fetch(BASE + `/admin/participants/${P.F.id}/disable`, { method: "POST", headers: { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "test" }) });
    assert.equal(dis.status, 200);
    const sf = await call(client, "status", { participant_secret: P.F.secret });
    assert.equal(sf.error, "PARTICIPANT_DISABLED");
  }
  const mcpGet = await fetch(BASE + "/mcp");
  assert.equal(mcpGet.status, 405);
});
