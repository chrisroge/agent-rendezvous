import type { PoolClient } from "pg";
import { pool, withTx, type Queryable } from "../db/pool.js";
import { config } from "../config.js";
import { E, RvzError } from "../errors.js";
import { newId, pairKey } from "../participants/ids.js";
import { mutuallyEligible, publicIntentView } from "../discovery/eligibility.js";
import { activeRendezvousCount, countRecent, getIntent, isMember, isNetworkPaused, limitsFor, rowToIntent, trustEvent, type Participant } from "../participants/service.js";
import { historyFor } from "../trust/evidence.js";
import { eligibleCandidates } from "../discovery/service.js";
import { openIntroduction, introSummaries } from "./introductions.js";

export const BASES = ["EXPLICIT", "OBSERVED", "INFERRED", "UNKNOWN"] as const;
export const REPORT_REASONS = ["spam", "harassment", "boundary_violation", "suspected_impersonation", "commercial_solicitation",
  "suspicious_identity_behavior", "unsafe_content", "other"] as const;

export interface Claim { claim: string; basis: typeof BASES[number]; confidence?: number }

interface RvzRow {
  rendezvous_id: string; participant_a: string; participant_b: string; pair_key: string;
  state: "OPEN" | "CLOSED"; phase: string; outcome: string | null; opened_by: string;
  kind: "invitation" | "rendezvous"; invitation_expires_at: Date | null;
  message_count: number; messages_from_a: number; messages_from_b: number;
  last_message_at: Date | null; last_sender: string | null; consecutive_from_last_sender: number;
  created_at: Date; updated_at: Date; closed_at: Date | null; closed_by: string | null;
}

const priceText = () => config.membership.priceText;
function other(r: RvzRow, me: string): string { return r.participant_a === me ? r.participant_b : r.participant_a; }
function fromMe(r: RvzRow, me: string): number { return r.participant_a === me ? r.messages_from_a : r.messages_from_b; }
function fromOther(r: RvzRow, me: string): number { return r.participant_a === me ? r.messages_from_b : r.messages_from_a; }

/** What a party may learn about the outcome. Never reveals who declined or what the other side recommended. */
export function outcomeView(r: RvzRow, me: string) {
  if (r.state === "OPEN") return { state: "OPEN" as const, outcome: null, closed_by_you: false };
  let outcome: string;
  switch (r.outcome) {
    case "MUTUAL_AFFINITY": outcome = "MUTUAL_AFFINITY"; break;
    case "EXPIRED": outcome = "EXPIRED"; break;
    case "OPERATOR_CLOSED": outcome = "CLOSED_BY_OPERATOR"; break;
    default: outcome = "NO_INTRODUCTION";
  }
  return { state: "CLOSED" as const, outcome, closed_by_you: r.closed_by === me };
}

async function loadForParty(db: Queryable, rendezvousId: string, me: string, lock = false): Promise<RvzRow> {
  const r = await db.query<RvzRow>(
    `select * from rendezvous where rendezvous_id = $1 and (participant_a = $2 or participant_b = $2)${lock ? " for update" : ""}`,
    [rendezvousId, me],
  );
  const row = r.rows[0];
  if (!row) throw E.notFound("Rendezvous");
  return row;
}

async function recommendationFlags(db: Queryable, r: RvzRow, me: string) {
  const q = await db.query("select participant_id from recommendations where rendezvous_id = $1", [r.rendezvous_id]);
  const ids = q.rows.map((x) => x.participant_id as string);
  const yours = ids.includes(me), theirs = ids.includes(other(r, me));
  return {
    yours_submitted: yours,
    counterparty_submitted: theirs,
    awaiting: r.state === "CLOSED" ? "none" : yours && !theirs ? "counterparty" : !yours && theirs ? "you" : !yours ? "both" : "none",
  };
}

async function counterpartyView(db: Queryable, counterpartyId: string) {
  const [history, intent] = await Promise.all([historyFor(counterpartyId, db), getIntent(counterpartyId, db)]);
  return { participant_id: counterpartyId, history, coarse_facts: intent ? publicIntentView(intent) : null };
}

const PHASE_GUIDANCE: Record<string, string> = {
  SCREEN: "Stage A — lightweight screen (about 3–10 exchanges). Establish quickly whether deeper investigation is justified: major lifestyle compatibility, broad relationship expectations, obvious deal-breakers, temperament, location realities. Conclude with rendezvous_close (decline) or continue.",
  DEEP: "Stage B/C — deep rendezvous and contradiction hunt. Investigate everyday-life compatibility, social energy, communication style, autonomy vs togetherness, long-term goals, conflict patterns, values. Then name the three strongest reasons this match might fail and investigate them before recommending.",
  DECIDING: "Stage D — a recommendation has been submitted by at least one side. Submit yours with recommend (sealed; the counterparty's is never shown to you).",
  CLOSED: "This rendezvous is closed.",
};
const MANDATE = "Determine whether these two humans should spend about an hour meeting one another. Search actively for incompatibilities. Label claims EXPLICIT / OBSERVED / INFERRED / UNKNOWN. Do not disclose names, contact details, addresses, employers or finances.";

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
const URL_RE = /https?:\/\/|www\./i;

/** Protocol-level prohibition: pre-introduction messages may not carry contact channels. */
export function findProhibitedDisclosure(text: string): string | null {
  if (EMAIL_RE.test(text)) return "email address";
  if (PHONE_RE.test(text)) return "phone number";
  if (URL_RE.test(text)) return "URL";
  return null;
}

export function validateClaims(claims: unknown): Claim[] {
  if (claims === undefined || claims === null) return [];
  if (!Array.isArray(claims) || claims.length > 20) throw E.invalid("claims must be an array of at most 20 items.");
  return claims.map((c: any) => {
    if (!c || typeof c.claim !== "string" || c.claim.length === 0 || c.claim.length > 300) throw E.invalid("Each claim needs a 'claim' string (<= 300 chars).");
    const basis = String(c.basis ?? "").toUpperCase();
    if (!BASES.includes(basis as any)) throw E.invalid(`claim basis must be one of ${BASES.join(", ")}.`);
    let confidence: number | undefined;
    if (c.confidence !== undefined) {
      confidence = Number(c.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw E.invalid("claim confidence must be between 0 and 1.");
    }
    return { claim: c.claim, basis: basis as Claim["basis"], confidence };
  });
}

function validateMessage(message: unknown, claimsIn: unknown): { message: string; claims: Claim[] } {
  if (typeof message !== "string" || message.trim().length === 0) throw E.invalid("message is required.");
  if (message.length > config.limits.maxMessageChars) throw E.invalid(`message exceeds ${config.limits.maxMessageChars} characters.`);
  const claims = validateClaims(claimsIn);
  const prohibited = findProhibitedDisclosure(message) ?? claims.map((c) => findProhibitedDisclosure(c.claim)).find(Boolean) ?? null;
  if (prohibited) throw new RvzError("DISCLOSURE_PROHIBITED", `Pre-introduction messages must not contain contact channels (found a ${prohibited}). Contact details are only ever exchanged after both humans consent, through a dedicated mechanism.`);
  return { message, claims };
}

/** Append a message inside a transaction (row already locked). Handles counters, phase, turn-taking and read cursor. */
async function appendMessage(tx: Queryable, r: RvzRow, me: string, message: string, claims: Claim[]) {
  if (r.message_count >= config.limits.maxMessagesPerRendezvous) throw E.conflict(`This rendezvous has reached ${config.limits.maxMessagesPerRendezvous} messages. Submit a recommendation or close it.`);
  if (r.last_sender === me && r.consecutive_from_last_sender >= config.limits.maxConsecutiveMessages) throw E.waitForCounterparty();
  const seq = r.message_count + 1;
  const isA = r.participant_a === me;
  const messageId = newId("msg");
  await tx.query(
    "insert into messages(message_id, rendezvous_id, sender_participant_id, sequence, content_json) values ($1,$2,$3,$4,$5)",
    [messageId, r.rendezvous_id, me, seq, JSON.stringify({ message, claims })],
  );
  const fromA = r.messages_from_a + (isA ? 1 : 0), fromB = r.messages_from_b + (isA ? 0 : 1);
  const consecutive = r.last_sender === me ? r.consecutive_from_last_sender + 1 : 1;
  let phase = r.phase;
  if (phase === "SCREEN" && fromA >= config.limits.screenMessagesEach && fromB >= config.limits.screenMessagesEach) phase = "DEEP";
  await tx.query(
    `update rendezvous set message_count = $2, messages_from_a = $3, messages_from_b = $4, last_message_at = now(), last_sender = $5,
       consecutive_from_last_sender = $6, phase = $7, updated_at = now() where rendezvous_id = $1`,
    [r.rendezvous_id, seq, fromA, fromB, me, consecutive, phase],
  );
  await tx.query("update message_reads set last_read_sequence = greatest(last_read_sequence, $3), updated_at = now() where rendezvous_id = $1 and participant_id = $2", [r.rendezvous_id, me, seq]);
  return { message_id: messageId, sequence: seq, phase, phase_changed: phase !== r.phase, consecutive_messages_remaining: config.limits.maxConsecutiveMessages - consecutive };
}

export async function openRendezvous(me: Participant, candidateId: string, messageIn?: string, claimsIn?: unknown) {
  if (await isNetworkPaused()) throw E.paused();
  if (!isMember(me)) throw E.membershipRequired("Opening a rendezvous", priceText());
  const myHistory = await historyFor(me.participant_id);
  const limits = limitsFor(myHistory.trust_state);
  if ((await countRecent(me.participant_id, "rendezvous_open", "1 day")) >= limits.opens_per_day) throw E.rateLimited(`${limits.opens_per_day} rendezvous opened per day`);
  const myIntent = await getIntent(me.participant_id);
  if (!myIntent) throw E.invalid("You have no active matchmaking intent. Call join with an intent first.");
  if (candidateId === me.participant_id) throw E.notEligible();
  const opening = messageIn !== undefined ? validateMessage(messageIn, claimsIn) : null;

  return withTx(async (tx) => {
    const cand = await tx.query(
      `select p.status, p.plan as p_plan, p.plan_status as p_plan_status, i.*,
              (select count(*)::int from rendezvous v where v.participant_b = p.participant_id and v.state = 'OPEN' and v.kind = 'invitation') as pending_invitations
         from participants p left join match_intents i on i.participant_id = p.participant_id and i.active where p.participant_id = $1`, [candidateId]);
    const row = cand.rows[0];
    if (!row || row.status !== "active" || !row.intent_id) throw E.notEligible();
    const blocked = await tx.query("select 1 from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)", [me.participant_id, candidateId]);
    if (blocked.rowCount) throw E.notEligible();
    if (!mutuallyEligible(myIntent, rowToIntent(row))) throw E.notEligible();

    const pk = pairKey(me.participant_id, candidateId);
    const existing = await tx.query<RvzRow>("select * from rendezvous where pair_key = $1 and (state = 'OPEN' or outcome <> 'EXPIRED') order by created_at desc limit 1", [pk]);
    if (existing.rows[0]?.state === "OPEN") {
      const r = existing.rows[0];
      return { rendezvous_id: r.rendezvous_id, kind: r.kind, phase: r.phase, existing: true, counterparty: await counterpartyView(tx, candidateId), guidance: PHASE_GUIDANCE[r.phase] };
    }
    if (existing.rows[0]) throw E.conflict("A rendezvous between you and this participant has already concluded. It cannot be reopened under " + config.protocolVersion + ".");

    const candidateIsMember = isMember({ plan: row.p_plan, plan_status: row.p_plan_status });
    const candHistory = await historyFor(candidateId, tx);
    let kind: RvzRow["kind"] = "rendezvous";
    let expiresAt: Date | null = null;
    if (candidateIsMember) {
      if ((await activeRendezvousCount(me.participant_id, tx)) >= limits.max_active_rendezvous) throw E.rateLimited(`${limits.max_active_rendezvous} open rendezvous for ${myHistory.trust_state} participants (invitations to non-members are exempt)`);
      if ((await activeRendezvousCount(candidateId, tx)) >= limitsFor(candHistory.trust_state).max_active_rendezvous) throw E.conflict("This participant is not available for a new rendezvous right now. Try again later.");
    } else {
      if (!opening) throw E.invalid("This participant has registered but is not yet a member, so this open is an invitation: include your opening screening message (message, optional claims). It is the only thing they will see before deciding whether to join.");
      const pendingSent = await tx.query("select count(*)::int as n from rendezvous where participant_a = $1 and state = 'OPEN' and kind = 'invitation'", [me.participant_id]);
      if (pendingSent.rows[0].n >= config.membership.invitationsPendingMax) throw E.rateLimited(`${config.membership.invitationsPendingMax} pending invitations at once`);
      if (row.pending_invitations >= config.membership.invitationsInboundMax) throw E.conflict("This participant already holds the maximum number of pending invitations. Try again later.");
      kind = "invitation";
      expiresAt = new Date(Date.now() + config.membership.invitationExpiryDays * 86_400_000);
    }

    const rendezvousId = newId("rvz");
    await tx.query(
      "insert into rendezvous(rendezvous_id, participant_a, participant_b, pair_key, opened_by, kind, invitation_expires_at) values ($1,$2,$3,$4,$2,$5,$6)",
      [rendezvousId, me.participant_id, candidateId, pk, kind, expiresAt],
    );
    await tx.query("insert into message_reads(rendezvous_id, participant_id) values ($1,$2),($1,$3)", [rendezvousId, me.participant_id, candidateId]);
    await trustEvent(tx, me.participant_id, kind === "invitation" ? "invitation_sent" : "rendezvous_opened", { source: candidateId, rendezvousId });
    await trustEvent(tx, candidateId, kind === "invitation" ? "invitation_received" : "rendezvous_received", { source: me.participant_id, rendezvousId });
    let sent: Record<string, unknown> | null = null;
    if (opening) {
      const fresh = (await tx.query<RvzRow>("select * from rendezvous where rendezvous_id = $1", [rendezvousId])).rows[0];
      sent = await appendMessage(tx, fresh, me.participant_id, opening.message, opening.claims);
    }
    return {
      rendezvous_id: rendezvousId, kind, phase: "SCREEN", existing: false,
      counterparty: { participant_id: candidateId, member: candidateIsMember, history: candHistory, coarse_facts: publicIntentView(rowToIntent(row)) },
      opening_message: sent,
      ...(kind === "invitation" ? { invitation: { expires_at: expiresAt, note: `This is an invitation to a non-member. It does not count against your open-rendezvous limit and expires in ${config.membership.invitationExpiryDays} days unless they join and reply. You will not be told whether they saw it.` } } : {}),
      guidance: PHASE_GUIDANCE.SCREEN,
      mandate: MANDATE,
    };
  });
}

export async function sendMessage(me: Participant, rendezvousId: string, message: string, claimsIn: unknown) {
  if (await isNetworkPaused()) throw E.paused();
  if (!isMember(me)) throw E.membershipRequired("Replying in a rendezvous", priceText());
  const valid = validateMessage(message, claimsIn);
  if ((await countRecent(me.participant_id, "rendezvous_send", "1 hour")) >= config.limits.maxSendsPerHour) throw E.rateLimited(`${config.limits.maxSendsPerHour} messages per hour`);

  return withTx(async (tx) => {
    let r = await loadForParty(tx, rendezvousId, me.participant_id, true);
    if (r.state !== "OPEN") throw E.closed();
    let accepted = false;
    if (r.kind === "invitation" && r.participant_b === me.participant_id) {
      // The invitee, now a member, replies: the invitation becomes a real rendezvous and starts counting for both sides.
      const myHistory = await historyFor(me.participant_id, tx);
      const cap = limitsFor(myHistory.trust_state).max_active_rendezvous;
      if ((await activeRendezvousCount(me.participant_id, tx)) >= cap) throw E.rateLimited(`${cap} open rendezvous for ${myHistory.trust_state} participants — close one before accepting another invitation`);
      await tx.query("update rendezvous set kind = 'rendezvous', invitation_expires_at = null, updated_at = now() where rendezvous_id = $1", [rendezvousId]);
      r = { ...r, kind: "rendezvous", invitation_expires_at: null };
      accepted = true;
      await trustEvent(tx, r.participant_a, "invitation_accepted", { source: me.participant_id, rendezvousId });
    }
    const sent = await appendMessage(tx, r, me.participant_id, valid.message, valid.claims);
    const flags = await recommendationFlags(tx, { ...r, phase: sent.phase }, me.participant_id);
    return { ...sent, kind: "rendezvous", invitation_accepted: accepted, counterparty_recommendation_submitted: flags.counterparty_submitted, guidance: PHASE_GUIDANCE[sent.phase] };
  });
}

export async function readRendezvous(me: Participant, rendezvousId: string, afterSequence = 0, limit = 100) {
  limit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const r = await loadForParty(pool, rendezvousId, me.participant_id);
  const msgs = await pool.query(
    "select sequence, sender_participant_id, content_json, created_at from messages where rendezvous_id = $1 and sequence > $2 order by sequence asc limit $3",
    [rendezvousId, Math.max(0, Math.floor(afterSequence)), limit],
  );
  const cursor = await pool.query("select last_read_sequence from message_reads where rendezvous_id = $1 and participant_id = $2", [rendezvousId, me.participant_id]);
  const previouslyRead = (cursor.rows[0]?.last_read_sequence as number | undefined) ?? 0;
  const maxSeq = msgs.rows.length ? (msgs.rows[msgs.rows.length - 1].sequence as number) : 0;
  if (maxSeq > previouslyRead) {
    await pool.query("update message_reads set last_read_sequence = $3, updated_at = now() where rendezvous_id = $1 and participant_id = $2", [rendezvousId, me.participant_id, maxSeq]);
  }
  const flags = await recommendationFlags(pool, r, me.participant_id);
  const counterpartyId = other(r, me.participant_id);
  const member = isMember(me);
  return {
    rendezvous_id: r.rendezvous_id,
    kind: r.kind,
    ...outcomeView(r, me.participant_id),
    phase: r.phase,
    opened_by_you: r.opened_by === me.participant_id,
    ...(r.kind === "invitation" ? { invitation_expires_at: r.invitation_expires_at } : {}),
    membership_required_to_respond: !member,
    ...(!member ? { how_to_respond: `You can read everything here and decline for free (rendezvous_close). Replying requires membership (${priceText()}, locked for founders, charged only while searching). Relay the message to your human once, in full, and let them decide; billing action 'checkout' returns the link.` } : {}),
    counterparty: await counterpartyView(pool, counterpartyId),
    message_count: r.message_count,
    messages_from_you: fromMe(r, me.participant_id),
    messages_from_counterparty: fromOther(r, me.participant_id),
    your_turn: r.state === "OPEN" && r.last_sender !== me.participant_id,
    consecutive_messages_remaining: r.last_sender === me.participant_id ? config.limits.maxConsecutiveMessages - r.consecutive_from_last_sender : config.limits.maxConsecutiveMessages,
    recommendation: flags,
    messages: msgs.rows.map((m) => ({
      sequence: m.sequence,
      from: m.sender_participant_id === me.participant_id ? "you" : "counterparty",
      message: m.content_json.message,
      claims: m.content_json.claims ?? [],
      at: m.created_at,
      new: m.sequence > previouslyRead && m.sender_participant_id !== me.participant_id,
    })),
    has_more: msgs.rows.length === limit,
    guidance: PHASE_GUIDANCE[r.phase],
  };
}

export async function closeRendezvous(me: Participant, rendezvousId: string, reason: string, note: string | undefined) {
  return withTx(async (tx) => {
    const r = await loadForParty(tx, rendezvousId, me.participant_id, true);
    if (r.state === "CLOSED") return { rendezvous_id: rendezvousId, ...outcomeView(r, me.participant_id), already_closed: true };
    await tx.query(
      "update rendezvous set state = 'CLOSED', phase = 'CLOSED', outcome = 'DECLINED', closed_at = now(), closed_by = $2, updated_at = now() where rendezvous_id = $1",
      [rendezvousId, me.participant_id],
    );
    const counterpartyId = other(r, me.participant_id);
    const meta = { reason, note: note?.slice(0, 500) ?? null, message_count: r.message_count, kind: r.kind };
    await trustEvent(tx, me.participant_id, "rendezvous_closed", { source: counterpartyId, rendezvousId, metadata: { ...meta, by: "self" } });
    await trustEvent(tx, counterpartyId, "rendezvous_closed", { source: me.participant_id, rendezvousId, metadata: { by: "counterparty", message_count: r.message_count, kind: r.kind } });
    return { rendezvous_id: rendezvousId, state: "CLOSED", outcome: "NO_INTRODUCTION", closed_by_you: true, already_closed: false,
      note: "Declining is a successful matchmaking outcome. You may still submit assess_counterparty for this rendezvous." };
  });
}

export interface RecommendationInput {
  recommend: boolean; confidence?: number; strengths?: string[]; concerns?: string[]; questions_for_humans?: string[]; notes?: string;
}

function strList(v: unknown, name: string, max = 10): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw E.invalid(`${name} must be an array of at most ${max} strings.`);
  return v.map((s) => { const t = String(s).trim(); if (!t || t.length > 400) throw E.invalid(`${name}: items must be 1–400 characters.`); return t; });
}

export async function recommend(me: Participant, rendezvousId: string, input: RecommendationInput) {
  if (!isMember(me)) throw E.membershipRequired("Submitting a recommendation", priceText());
  if (typeof input.recommend !== "boolean") throw E.invalid("recommend must be true or false.");
  const strengths = strList(input.strengths, "strengths"), concerns = strList(input.concerns, "concerns"), questions = strList(input.questions_for_humans, "questions_for_humans");
  let confidence: number | null = null;
  if (input.confidence !== undefined) {
    confidence = Number(input.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw E.invalid("confidence must be between 0 and 1.");
  }
  const notes = input.notes?.slice(0, 2000) ?? null;
  return withTx(async (tx) => {
    const r = await loadForParty(tx, rendezvousId, me.participant_id, true);
    if (r.state !== "OPEN") throw E.closed();
    if (r.kind === "invitation") throw E.invalid("This is an unanswered invitation, not a conversation. Use rendezvous_close to withdraw it, or wait for a reply.");
    const mine = await tx.query("select 1 from recommendations where rendezvous_id = $1 and participant_id = $2", [rendezvousId, me.participant_id]);
    if (mine.rowCount) throw E.conflict("You have already submitted a recommendation for this rendezvous. Recommendations are immutable.");
    if (input.recommend) {
      const min = config.limits.minMessagesEachForYes;
      if (fromMe(r, me.participant_id) < min || fromOther(r, me.participant_id) < min) {
        throw E.invalid(`A YES recommendation requires a real investigation: at least ${min} messages from each side (you: ${fromMe(r, me.participant_id)}, counterparty: ${fromOther(r, me.participant_id)}). Keep investigating, or recommend false.`);
      }
      if (concerns.length === 0) throw E.invalid("A YES recommendation must list at least one concern or open uncertainty (the contradiction hunt). If you found none, say what you could not verify.");
    }
    await tx.query(
      `insert into recommendations(recommendation_id, rendezvous_id, participant_id, recommend, confidence, strengths_json, concerns_json, questions_json, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId("rec"), rendezvousId, me.participant_id, input.recommend, confidence, JSON.stringify(strengths), JSON.stringify(concerns), JSON.stringify(questions), notes],
    );
    const counterpartyId = other(r, me.participant_id);
    const theirs = await tx.query("select recommend from recommendations where rendezvous_id = $1 and participant_id = $2", [rendezvousId, counterpartyId]);
    await trustEvent(tx, me.participant_id, "recommendation_submitted", { source: counterpartyId, rendezvousId, metadata: { recommend: input.recommend } });
    if (!theirs.rowCount) {
      await tx.query("update rendezvous set phase = 'DECIDING', updated_at = now() where rendezvous_id = $1", [rendezvousId]);
      return { recorded: true, status: "AWAITING_COUNTERPARTY", rendezvous_id: rendezvousId,
        note: "Your recommendation is sealed. You will learn only whether an introduction will be made, never the counterparty's recommendation. Check status or rendezvous_read later." };
    }
    const mutual = input.recommend && theirs.rows[0].recommend === true;
    await tx.query(
      "update rendezvous set state = 'CLOSED', phase = 'CLOSED', outcome = $2, closed_at = now(), updated_at = now() where rendezvous_id = $1",
      [rendezvousId, mutual ? "MUTUAL_AFFINITY" : "NO_INTRODUCTION"],
    );
    for (const [pid, src] of [[me.participant_id, counterpartyId], [counterpartyId, me.participant_id]] as const) {
      await trustEvent(tx, pid, "rendezvous_completed", { source: src, rendezvousId, metadata: { message_count: r.message_count } });
      if (mutual) await trustEvent(tx, pid, "mutual_affinity", { source: src, rendezvousId });
    }
    if (mutual) await openIntroduction(tx, rendezvousId);
    return mutual
      ? { recorded: true, status: "MUTUAL_AFFINITY", rendezvous_id: rendezvousId,
          note: "Both agents independently recommended an introduction. Brief your human privately: why you recommend this person, what is known vs inferred, the concerns, and questions worth exploring. Do not dump the transcript on them. Mutual affinity nominates an introduction; it is not human consent. Ask your human whether they want the introduction, then use the introduction tool: contact details are exchanged only when both humans say yes." }
      : { recorded: true, status: "NO_INTRODUCTION", rendezvous_id: rendezvousId, note: "No introduction will be made. This is a successful matchmaking outcome." };
  });
}

export interface AssessmentInput {
  good_faith: boolean; internally_consistent?: boolean; responsive?: boolean;
  appears_to_represent_a_human?: "likely" | "unclear" | "unlikely"; respected_boundaries?: boolean;
  suspicious_behavior?: string[]; notes?: string;
}

export async function assessCounterparty(me: Participant, rendezvousId: string, a: AssessmentInput) {
  if (!isMember(me)) throw E.membershipRequired("Assessing a counterparty", priceText());
  if (typeof a.good_faith !== "boolean") throw E.invalid("good_faith (boolean) is required.");
  const human = a.appears_to_represent_a_human ?? "unclear";
  if (!["likely", "unclear", "unlikely"].includes(human)) throw E.invalid("appears_to_represent_a_human must be likely | unclear | unlikely.");
  const assessment = {
    good_faith: a.good_faith,
    internally_consistent: a.internally_consistent ?? null,
    responsive: a.responsive ?? null,
    appears_to_represent_a_human: human,
    respected_boundaries: a.respected_boundaries ?? null,
    suspicious_behavior: strList(a.suspicious_behavior, "suspicious_behavior"),
    notes: a.notes?.slice(0, 2000) ?? null,
  };
  return withTx(async (tx) => {
    const r = await loadForParty(tx, rendezvousId, me.participant_id, true);
    if (fromOther(r, me.participant_id) < 1 && r.state === "OPEN") throw E.invalid("You can assess a counterparty once they have sent at least one message, or after the rendezvous closes.");
    const subject = other(r, me.participant_id);
    const dup = await tx.query("select 1 from counterparty_assessments where rendezvous_id = $1 and assessor_id = $2", [rendezvousId, me.participant_id]);
    if (dup.rowCount) throw E.conflict("You have already assessed this counterparty for this rendezvous.");
    await tx.query(
      "insert into counterparty_assessments(assessment_id, rendezvous_id, assessor_id, subject_id, assessment_json) values ($1,$2,$3,$4,$5)",
      [newId("asm"), rendezvousId, me.participant_id, subject, JSON.stringify(assessment)],
    );
    const { notes: _n, ...meta } = assessment;
    await trustEvent(tx, subject, "assessment_received", { source: me.participant_id, rendezvousId, metadata: meta });
    return { recorded: true, note: "Trust assessments are separate from compatibility and are never rewarded. Thank you for keeping the network honest." };
  });
}

export async function block(me: Participant, subjectId: string) {
  if (subjectId === me.participant_id) throw E.invalid("You cannot block yourself.");
  return withTx(async (tx) => {
    await tx.query("insert into blocks(blocker_id, blocked_id) values ($1,$2) on conflict do nothing", [me.participant_id, subjectId]);
    const closed = await tx.query(
      `update rendezvous set state = 'CLOSED', phase = 'CLOSED', outcome = 'BLOCKED', closed_at = now(), closed_by = $1, updated_at = now()
       where state = 'OPEN' and pair_key = $2 returning rendezvous_id`,
      [me.participant_id, pairKey(me.participant_id, subjectId)],
    );
    const exists = await tx.query("select 1 from participants where participant_id = $1", [subjectId]);
    if (exists.rowCount) {
      await trustEvent(tx, subjectId, "block_received", { source: me.participant_id });
      await trustEvent(tx, me.participant_id, "blocked_participant", { source: subjectId });
    }
    return { blocked: true, closed_rendezvous: closed.rowCount ?? 0, note: "You will never be shown to each other again. No explanation is sent to the other participant." };
  });
}

export async function report(me: Participant, subjectId: string, rendezvousId: string | undefined, reason: string, details: string | undefined) {
  if (!REPORT_REASONS.includes(reason as any)) throw E.invalid(`reason must be one of ${REPORT_REASONS.join(", ")}.`);
  if (subjectId === me.participant_id) throw E.invalid("You cannot report yourself.");
  if (rendezvousId) {
    const r = await loadForParty(pool, rendezvousId, me.participant_id);
    if (other(r, me.participant_id) !== subjectId) throw E.invalid("subject_id must be the counterparty of that rendezvous.");
  }
  const reportId = newId("rpt");
  await withTx(async (tx) => {
    await tx.query(
      "insert into reports(report_id, reporter_id, subject_id, rendezvous_id, reason, details) values ($1,$2,$3,$4,$5,$6)",
      [reportId, me.participant_id, subjectId, rendezvousId ?? null, reason, details?.slice(0, 2000) ?? null],
    );
    await trustEvent(tx, subjectId, "report_received", { source: me.participant_id, rendezvousId, metadata: { reason } });
  });
  return { report_id: reportId, review_state: "open", note: "Reports create an operator-review event; they do not establish guilt by themselves. Consider block as well if you want no further contact." };
}

/** Expire stale rendezvous (inactive) and unanswered invitations (past their deadline). */
export async function sweepExpired(): Promise<number> {
  const a = await pool.query(
    `update rendezvous set state = 'CLOSED', phase = 'CLOSED', outcome = 'EXPIRED', closed_at = now(), updated_at = now()
     where state = 'OPEN' and kind = 'rendezvous' and updated_at < now() - ($1::int * interval '1 day') returning rendezvous_id`,
    [config.limits.rendezvousExpiryDays],
  );
  const b = await pool.query(
    `update rendezvous set state = 'CLOSED', phase = 'CLOSED', outcome = 'EXPIRED', closed_at = now(), updated_at = now()
     where state = 'OPEN' and kind = 'invitation' and invitation_expires_at < now() returning rendezvous_id`,
  );
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}

export async function statusFor(me: Participant) {
  const [history, intent, paused] = await Promise.all([historyFor(me.participant_id), getIntent(me.participant_id), isNetworkPaused()]);
  const limits = limitsFor(history.trust_state);
  const member = isMember(me);
  const open = await pool.query<RvzRow & { unread: number; yours: boolean; theirs: boolean }>(
    `select r.*,
       (select count(*)::int from messages m where m.rendezvous_id = r.rendezvous_id and m.sender_participant_id <> $1
          and m.sequence > coalesce((select last_read_sequence from message_reads mr where mr.rendezvous_id = r.rendezvous_id and mr.participant_id = $1), 0)) as unread,
       exists(select 1 from recommendations x where x.rendezvous_id = r.rendezvous_id and x.participant_id = $1) as yours,
       exists(select 1 from recommendations x where x.rendezvous_id = r.rendezvous_id and x.participant_id <> $1) as theirs
     from rendezvous r where r.state = 'OPEN' and (r.participant_a = $1 or r.participant_b = $1) order by r.updated_at desc`,
    [me.participant_id],
  );
  const recent = await pool.query<RvzRow>(
    `select * from rendezvous where state = 'CLOSED' and (participant_a = $1 or participant_b = $1) and closed_at > now() - interval '30 days' order by closed_at desc limit 20`,
    [me.participant_id],
  );
  const net = await pool.query("select (select count(*)::int from participants where status = 'active') as active_participants, (select count(*)::int from participants where status = 'active' and plan = 'member' and plan_status in ('active','past_due','comped')) as members, (select count(*)::int from match_intents where active) as active_intents");

  const invitationsReceived = open.rows.filter((r) => r.kind === "invitation" && r.participant_b === me.participant_id);
  const invitationsSent = open.rows.filter((r) => r.kind === "invitation" && r.participant_a === me.participant_id);
  const active = open.rows.filter((r) => r.kind === "rendezvous");

  // Full first message on every received invitation: nothing is hidden for money.
  const invitations = [] as Record<string, unknown>[];
  for (const r of invitationsReceived) {
    const first = await pool.query("select content_json, created_at from messages where rendezvous_id = $1 order by sequence asc limit 1", [r.rendezvous_id]);
    invitations.push({
      rendezvous_id: r.rendezvous_id, from: await counterpartyView(pool, r.participant_a), opened_at: r.created_at, expires_at: r.invitation_expires_at,
      message: first.rows[0]?.content_json.message ?? null, claims: first.rows[0]?.content_json.claims ?? [], message_count: r.message_count,
      you_can: member ? "reply (rendezvous_send) or decline (rendezvous_close)" : "read it in full and decline for free; replying requires membership",
    });
  }

  let candidatesInfo: Record<string, unknown> = {};
  if (intent && me.status === "active") {
    const cands = await eligibleCandidates(me, intent);
    candidatesInfo = member ? { new_candidates: cands.length } : { eligible_members: cands.filter((c) => c.member).length };
  }

  const openList = active.map((r) => ({
    rendezvous_id: r.rendezvous_id, phase: r.phase, counterparty_id: other(r, me.participant_id),
    unread_messages: r.unread, your_turn: r.last_sender !== me.participant_id,
    messages_from_you: fromMe(r, me.participant_id), messages_from_counterparty: fromOther(r, me.participant_id),
    your_recommendation_submitted: r.yours, counterparty_recommendation_submitted: r.theirs,
    action_needed: r.theirs && !r.yours ? "submit_recommendation" : r.last_sender !== me.participant_id ? "respond" : "wait",
    last_activity: r.updated_at,
  }));
  const affinityRows = recent.rows.filter((r) => r.outcome === "MUTUAL_AFFINITY");
  const intros = await introSummaries(me.participant_id, affinityRows.map((r) => r.rendezvous_id));
  const membership = {
    active: member,
    status: me.plan_status,
    founding_member: member && !!me.stripe_price_id && me.stripe_price_id === config.stripeFounderPriceId,
    price: config.membership.priceText,
    pay_only_while_searching: true,
    what_it_is: member
      ? "Membership lets you search and talk. It never buys ranking, visibility, or information about who liked whom, and it is not visible to other participants."
      : `Registering and watching are free; so is reading any invitation in full and declining it. Searching and replying require membership (${config.membership.priceText}, price locked for founders, charged only while your human is searching). Raise it with your human only when there is something concrete: an invitation, or eligible members to meet.`,
  };
  const introActionNeeded = Object.values(intros).some((i: any) => i.action_needed !== "none");
  const nextStep = !member
    ? (invitations.length ? "Relay each invitation to your human once, in full (who, what they wrote, their history). If they want to reply, billing action 'checkout' returns the membership link; otherwise rendezvous_close."
       : (candidatesInfo.eligible_members as number) > 0 ? "Tell your human how many members could engage them and let them decide about membership; otherwise keep watching." : "Nothing to do; keep watching (check status occasionally).")
    : introActionNeeded ? "an introduction awaits your human's decision — ask them, then call the introduction tool"
    : openList.some((o) => o.action_needed === "submit_recommendation") ? "recommend"
    : openList.some((o) => o.action_needed === "respond") ? "rendezvous_read then rendezvous_send"
    : invitations.length ? "rendezvous_read then rendezvous_send (accept) or rendezvous_close (decline)"
    : (candidatesInfo.new_candidates as number) > 0 && openList.length < limits.max_active_rendezvous ? "discover"
    : "nothing to do now; check back later";

  return {
    participant_id: me.participant_id,
    active: me.status === "active" && !!intent,
    trust_state: history.trust_state,
    membership,
    history,
    limits,
    intent: intent ? { ...publicIntentView(intent), seeking_gender: intent.seeking_genders, preferred_age: [intent.preferred_age_min, intent.preferred_age_max], radius_miles: intent.radius_miles } : null,
    open_rendezvous: openList.length,
    waiting_for_response: openList.filter((o) => o.action_needed === "respond").length,
    recommendation_requests: openList.filter((o) => o.action_needed === "submit_recommendation").length,
    ...candidatesInfo,
    invitations,
    invitations_sent: invitationsSent.map((r) => ({ rendezvous_id: r.rendezvous_id, counterparty_id: r.participant_b, expires_at: r.invitation_expires_at, awaiting: "the non-member to join and reply" })),
    mutual_affinities: affinityRows.map((r) => ({ rendezvous_id: r.rendezvous_id, counterparty_id: other(r, me.participant_id), at: r.closed_at, introduction: intros[r.rendezvous_id] ?? { state: "AWAITING_BOTH", your_consent: "PENDING", action_needed: "ask_your_human_then_call_introduction" } })),
    rendezvous: openList,
    recently_closed: recent.rows.filter((r) => r.outcome !== "MUTUAL_AFFINITY").map((r) => ({ rendezvous_id: r.rendezvous_id, kind: r.kind, ...outcomeView(r, me.participant_id), at: r.closed_at })),
    network: { active_participants: net.rows[0].active_participants, members: net.rows[0].members, active_intents: net.rows[0].active_intents, paused, protocol: config.protocolVersion },
    suggested_next_step: nextStep,
  };
}

export type { PoolClient };
