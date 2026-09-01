import { createHash, randomBytes } from "node:crypto";
import { junePool } from "./db.js";
import { networkCall } from "./network.js";
import { brief } from "./briefing.js";

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: "june-engine", ...o }));
const record = (clientId: string | null, kind: string, detail: Record<string, unknown> = {}) =>
  junePool.query("insert into june_actions(client_id, kind, detail) values ($1,$2,$3)", [clientId, kind, JSON.stringify(detail)]).catch(() => {});

/** Ensure this client has a network identity (June holds the credential). Joins on first search. */
async function ensureOnNetwork(clientId: string, intent: Record<string, unknown>): Promise<{ secret: string; participantId: string }> {
  const d = await junePool.query("select network_secret, network_participant_id from dossiers where client_id = $1", [clientId]);
  if (d.rows[0]?.network_secret) {
    await networkCall("join", { participant_secret: d.rows[0].network_secret, intent }); // refresh intent
    return { secret: d.rows[0].network_secret, participantId: d.rows[0].network_participant_id };
  }
  const r = await networkCall("join", { intent, client: { name: "june-matchmaker", platform: "june" } });
  await junePool.query("update dossiers set network_secret = $2, network_participant_id = $3 where client_id = $1", [clientId, r.participant_secret, r.participant_id]);
  await record(clientId, "joined_network", { participant_id: r.participant_id });
  return { secret: r.participant_secret, participantId: r.participant_id };
}

/**
 * One cycle for one client: check status, become a member if there is someone eligible, discover, open/advance rendezvous,
 * conduct the investigation, recommend, and surface affinities as briefings. Bounded work per cycle to stay cheap.
 * June is a normal member: she pays the $5 membership like anyone (the operator can comp her identities for the pilot).
 */
async function cycleClient(clientId: string, intent: Record<string, unknown>): Promise<void> {
  const { secret } = await ensureOnNetwork(clientId, intent);
  const status = await networkCall("status", { participant_secret: secret });

  // Surface any mutual affinity as a briefing the client can act on.
  for (const aff of status.mutual_affinities ?? []) {
    const exists = await junePool.query("select 1 from briefings where client_id = $1 and rendezvous_id = $2", [clientId, aff.rendezvous_id]);
    if (exists.rowCount) continue;
    const read = await networkCall("rendezvous_read", { participant_secret: secret, rendezvous_id: aff.rendezvous_id, limit: 200 });
    const body = await brief(clientId, read);
    await junePool.query("insert into briefings(briefing_id, client_id, rendezvous_id, kind, body) values ($1,$2,$3,'affinity',$4)",
      [`jb_${randomBytes(9).toString("hex")}`, clientId, aff.rendezvous_id, body]);
    await record(clientId, "affinity_briefing", { rendezvous_id: aff.rendezvous_id });
    log({ msg: "affinity → briefing queued", clientId });
  }

  if (!status.membership?.active) {
    const eligible = status.eligible_members ?? 0;
    if (eligible <= 0) { await record(clientId, "watching", { eligible_members: 0 }); return; }
    // Someone worth investigating exists: June needs membership. In the pilot she is comped; otherwise this is where her own billing lives.
    await record(clientId, "needs_membership", { eligible_members: eligible });
    log({ level: "warn", msg: "june client needs membership to proceed", clientId, eligible });
    return;
  }

  // Advance one open rendezvous per cycle (cheap, asynchronous by design).
  const mine = (await networkCall("status", { participant_secret: secret })).rendezvous ?? [];
  for (const r of mine.slice(0, 2)) {
    if (r.action_needed === "submit_recommendation" || r.your_turn) {
      const read = await networkCall("rendezvous_read", { participant_secret: secret, rendezvous_id: r.rendezvous_id, limit: 200 });
      const { conductInvestigation } = await import("./investigator.js");
      await conductInvestigation(clientId, secret, read);
    }
  }
  // Open one new rendezvous if we have capacity.
  if ((status.open_rendezvous ?? 0) < 2) {
    const disc = await networkCall("discover", { participant_secret: secret, limit: 3 });
    const cand = (disc.candidates ?? [])[0];
    if (cand) {
      const { openingMessage } = await import("./investigator.js");
      const msg = await openingMessage(clientId, cand);
      await networkCall("rendezvous_open", { participant_secret: secret, candidate_id: cand.candidate_id, message: msg.message, claims: msg.claims });
      await record(clientId, "opened_rendezvous", { candidate: cand.candidate_id, member: cand.member });
    }
  }
}

export async function cycle(): Promise<{ clients: number; errors: number }> {
  const clients = await junePool.query("select c.client_id, d.intent_json from clients c join dossiers d on d.client_id = c.client_id where c.status = 'searching' and d.interview_complete and d.intent_json is not null order by c.last_seen_at desc limit 25");
  let errors = 0;
  for (const c of clients.rows) {
    try { await cycleClient(c.client_id, c.intent_json); }
    catch (e) { errors++; log({ level: "error", msg: "client cycle failed", clientId: c.client_id, error: (e as Error).message }); await record(c.client_id, "cycle_error", { error: (e as Error).message }); }
  }
  log({ msg: "june cycle", clients: clients.rowCount, errors });
  return { clients: clients.rowCount ?? 0, errors };
}

export { record };
