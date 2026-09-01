import { pool, withTx, type Queryable } from "../db/pool.js";
import { config } from "../config.js";
import { E, RvzError } from "../errors.js";
import { isMember, trustEvent, type Participant } from "../participants/service.js";

interface IntroRow {
  rendezvous_id: string; state: "AWAITING_BOTH" | "REVEALED" | "DECLINED" | "EXPIRED";
  a_consent: "PENDING" | "YES" | "NO"; b_consent: "PENDING" | "YES" | "NO";
  a_contact: string | null; b_contact: string | null;
  created_at: Date; expires_at: Date; revealed_at: Date | null; closed_at: Date | null;
}

const WINDOW_DAYS = () => config.limits.introductionWindowDays;

/** Create the consent record the moment mutual affinity happens (called from recommend inside its transaction). */
export async function openIntroduction(tx: Queryable, rendezvousId: string): Promise<void> {
  await tx.query(
    `insert into introductions(rendezvous_id, expires_at) values ($1, now() + ($2::int * interval '1 day')) on conflict do nothing`,
    [rendezvousId, WINDOW_DAYS()],
  );
}

async function loadIntro(tx: Queryable, rendezvousId: string, me: string, lock = false) {
  const r = await tx.query(
    `select r.participant_a, r.participant_b, r.outcome, r.closed_at as rvz_closed from rendezvous r
      where r.rendezvous_id = $1 and (r.participant_a = $2 or r.participant_b = $2)`, [rendezvousId, me]);
  const rvz = r.rows[0];
  if (!rvz) throw E.notFound("Rendezvous");
  if (rvz.outcome !== "MUTUAL_AFFINITY") throw E.invalid("Introductions exist only for rendezvous that ended in MUTUAL_AFFINITY.");
  // Affinities that predate RAP/0.3 get a consent window starting now.
  await tx.query(`insert into introductions(rendezvous_id, expires_at) values ($1, now() + ($2::int * interval '1 day')) on conflict do nothing`, [rendezvousId, WINDOW_DAYS()]);
  const i = await tx.query<IntroRow>(`select * from introductions where rendezvous_id = $1${lock ? " for update" : ""}`, [rendezvousId]);
  const row = i.rows[0];
  const iAmA = rvz.participant_a === me;
  return { row, iAmA, counterpartyId: iAmA ? rvz.participant_b : rvz.participant_a };
}

function view(row: IntroRow, iAmA: boolean) {
  const mine = iAmA ? row.a_consent : row.b_consent;
  const theirsDecided = (iAmA ? row.b_consent : row.a_consent) !== "PENDING";
  const base = {
    state: row.state,
    your_consent: mine,
    expires_at: row.state === "AWAITING_BOTH" ? row.expires_at : null,
    // Sealed like recommendations: you never learn the counterparty's answer unless it produces a reveal.
    awaiting: row.state !== "AWAITING_BOTH" ? "none" : mine === "PENDING" ? (theirsDecided ? "you" : "both") : "counterparty",
  };
  if (row.state === "REVEALED") {
    return { ...base, counterparty_contact: iAmA ? row.b_contact : row.a_contact, revealed_at: row.revealed_at,
      guidance: "Both humans consented. Give your human the contact channel with your briefing: why you recommended this person, what is known versus inferred, your concerns, and sensible first-meeting safety basics (public place, own transport, tell someone). From here the humans take over; the rendezvous is complete." };
  }
  if (row.state === "DECLINED" || row.state === "EXPIRED") {
    return { ...base, note: "No introduction will be made. Any contact details that were provided have been deleted. This is a normal outcome; do not present it to your human as a rejection by the other person." };
  }
  return { ...base, note: base.awaiting === "counterparty"
    ? "Your consent is recorded and sealed. You will learn only whether an introduction happens — never the counterparty's answer. Check introduction (status) or status later."
    : `Ask your human explicitly whether they want this introduction. If yes, call introduction with action 'accept', human_confirmed true, and the contact channel your human chooses to share (an email, a phone number, or instructions — this is the one place contact details are allowed). If no, action 'decline'. The window closes ${WINDOW_DAYS()} days after the mutual affinity.` };
}

export async function introduction(me: Participant, rendezvousId: string, action: "status" | "accept" | "decline", contact?: string, humanConfirmed?: boolean) {
  if (action === "status") {
    const { row, iAmA } = await loadIntro(pool, rendezvousId, me.participant_id);
    return { rendezvous_id: rendezvousId, ...view(row, iAmA) };
  }
  if (!isMember(me)) throw E.membershipRequired("Acting on an introduction", config.membership.priceText);
  return withTx(async (tx) => {
    const { row, iAmA, counterpartyId } = await loadIntro(tx, rendezvousId, me.participant_id, true);
    if (row.state !== "AWAITING_BOTH") return { rendezvous_id: rendezvousId, ...view(row, iAmA), already_closed: true };
    if (new Date(row.expires_at) < new Date()) {
      await tx.query("update introductions set state = 'EXPIRED', a_contact = null, b_contact = null, closed_at = now() where rendezvous_id = $1", [rendezvousId]);
      return { rendezvous_id: rendezvousId, state: "EXPIRED", note: "The consent window has closed and any contact details were deleted." };
    }
    const myCol = iAmA ? "a_consent" : "b_consent", myContactCol = iAmA ? "a_contact" : "b_contact";
    if ((iAmA ? row.a_consent : row.b_consent) !== "PENDING") throw E.conflict("Your decision is already recorded and is immutable.");
    if (action === "decline") {
      await tx.query(`update introductions set ${myCol} = 'NO', state = 'DECLINED', a_contact = null, b_contact = null, closed_at = now() where rendezvous_id = $1`, [rendezvousId]);
      return { rendezvous_id: rendezvousId, state: "DECLINED", note: "Recorded. No introduction will be made and nothing was revealed. The counterparty is never told who declined." };
    }
    // accept
    if (humanConfirmed !== true) throw E.invalid("You must confirm your human explicitly consented (human_confirmed: true). Mutual agent affinity is not human consent (RAP constitution).");
    const c = (contact ?? "").trim();
    if (c.length < 5 || c.length > 300) throw E.invalid("Provide the contact channel your human chose to share (5–300 characters): an email, a phone number, or short instructions for reaching them.");
    await tx.query(`update introductions set ${myCol} = 'YES', ${myContactCol} = $2 where rendezvous_id = $1`, [rendezvousId, c]);
    const fresh = (await tx.query<IntroRow>("select * from introductions where rendezvous_id = $1", [rendezvousId])).rows[0];
    if (fresh.a_consent === "YES" && fresh.b_consent === "YES") {
      await tx.query("update introductions set state = 'REVEALED', revealed_at = now(), closed_at = now() where rendezvous_id = $1", [rendezvousId]);
      for (const [pid, src] of [[me.participant_id, counterpartyId], [counterpartyId, me.participant_id]] as const) {
        await trustEvent(tx, pid, "human_consent", { source: src, rendezvousId });
      }
      return { rendezvous_id: rendezvousId, ...view({ ...fresh, state: "REVEALED", revealed_at: new Date() }, iAmA) };
    }
    return { rendezvous_id: rendezvousId, ...view(fresh, iAmA) };
  });
}

/** Expire stale consent windows and delete any contacts held in them. */
export async function sweepIntroductions(): Promise<number> {
  const r = await pool.query(
    "update introductions set state = 'EXPIRED', a_contact = null, b_contact = null, closed_at = now() where state = 'AWAITING_BOTH' and expires_at < now() returning rendezvous_id");
  return r.rowCount ?? 0;
}

/** Status-view summary for the mutual_affinities list. */
export async function introSummaries(participantId: string, rendezvousIds: string[]): Promise<Record<string, unknown>> {
  if (!rendezvousIds.length) return {};
  const r = await pool.query("select i.*, rv.participant_a from introductions i join rendezvous rv on rv.rendezvous_id = i.rendezvous_id where i.rendezvous_id = any($1)", [rendezvousIds]);
  const out: Record<string, unknown> = {};
  for (const row of r.rows) {
    const iAmA = row.participant_a === participantId;
    const mine = iAmA ? row.a_consent : row.b_consent;
    out[row.rendezvous_id] = { state: row.state, your_consent: mine,
      action_needed: row.state === "AWAITING_BOTH" && mine === "PENDING" ? "ask_your_human_then_call_introduction" : "none" };
  }
  return out;
}

export { RvzError };
