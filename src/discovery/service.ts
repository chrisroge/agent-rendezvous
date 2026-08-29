import { pool } from "../db/pool.js";
import { E } from "../errors.js";
import { config } from "../config.js";
import { mutuallyEligible, publicIntentView, type Intent } from "./eligibility.js";
import { activeRendezvousCount, countRecent, getIntent, isMember, limitsFor, rowToIntent, type Participant } from "../participants/service.js";
import { historyFor, type History } from "../trust/evidence.js";

export interface Candidate {
  candidate_id: string;
  member: boolean;
  history: History;
  coarse_facts: ReturnType<typeof publicIntentView>;
}

/**
 * Candidate generation: deterministic server-side filtering only.
 * Excludes self, blocked pairs (either direction), pairs with an existing non-expired rendezvous, inactive participants,
 * members already at their active-rendezvous cap, and non-members already holding the maximum number of pending invitations.
 */
export async function eligibleCandidates(me: Participant, myIntent: Intent): Promise<Candidate[]> {
  const r = await pool.query(
    `select i.*, p.plan as p_plan, p.plan_status as p_plan_status,
            (select count(*)::int from rendezvous v where v.participant_b = i.participant_id and v.state = 'OPEN' and v.kind = 'invitation') as pending_invitations
       from match_intents i
       join participants p on p.participant_id = i.participant_id
      where i.active and p.status = 'active' and i.participant_id <> $1
        and not exists (select 1 from blocks b where (b.blocker_id = $1 and b.blocked_id = i.participant_id)
                                                  or (b.blocker_id = i.participant_id and b.blocked_id = $1))
        and not exists (select 1 from rendezvous r where r.pair_key = (case when $1 < i.participant_id then $1 || '|' || i.participant_id else i.participant_id || '|' || $1 end)
                                                    and (r.state = 'OPEN' or r.outcome <> 'EXPIRED'))`,
    [me.participant_id],
  );
  const out: Candidate[] = [];
  for (const row of r.rows) {
    const intent = rowToIntent(row);
    if (!mutuallyEligible(myIntent, intent)) continue;
    const member = isMember({ plan: row.p_plan, plan_status: row.p_plan_status });
    if (!member && row.pending_invitations >= config.membership.invitationsInboundMax) continue;
    const history = await historyFor(intent.participant_id);
    if (member && (await activeRendezvousCount(intent.participant_id)) >= limitsFor(history.trust_state).max_active_rendezvous) continue;
    out.push({ candidate_id: intent.participant_id, member, history, coarse_facts: publicIntentView(intent) });
  }
  return out;
}

/** How many members could engage this participant right now — the honest number a non-member's agent can report to its human. */
export async function eligibleMemberCount(me: Participant): Promise<number> {
  const intent = await getIntent(me.participant_id);
  if (!intent || me.status !== "active") return 0;
  return (await eligibleCandidates(me, intent)).filter((c) => c.member).length;
}

export async function discover(me: Participant, limit: number, minimumHistory: "any" | "established"): Promise<Record<string, unknown>> {
  const myIntent = await getIntent(me.participant_id);
  if (!myIntent) throw E.invalid("You have no active matchmaking intent. Call join with an intent first.");
  if (!isMember(me)) {
    const n = (await eligibleCandidates(me, myIntent)).filter((c) => c.member).length;
    return {
      membership_required: true,
      eligible_members: n,
      candidates: [],
      note: n === 0
        ? `No members are currently eligible for your human. Registration and watching are free; keep checking status. Membership (${config.membership.priceText}) is only worth raising with your human once there is someone to meet.`
        : `${n} member${n === 1 ? "" : "s"} could engage your human right now. Searching and talking require membership (${config.membership.priceText}, price locked for founders, charged only while searching). Tell your human the number and let them decide; billing action 'checkout' returns the link.`,
    };
  }
  const myHistory = await historyFor(me.participant_id);
  const limits = limitsFor(myHistory.trust_state);
  if ((await countRecent(me.participant_id, "discover", "1 day")) >= limits.discover_per_day) {
    throw E.rateLimited(`${limits.discover_per_day} discovery requests per day for ${myHistory.trust_state} participants`);
  }
  const active = await activeRendezvousCount(me.participant_id);
  if (active >= limits.max_active_rendezvous) {
    return { candidates: [], searched: 0, note: `You already have ${active} open rendezvous (your limit is ${limits.max_active_rendezvous}). Conclude one before discovering more. Invitations to non-members do not count against this limit.` };
  }
  let all = await eligibleCandidates(me, myIntent);
  const searched = all.length;
  if (minimumHistory === "established") all = all.filter((c) => c.history.trust_state === "ESTABLISHED");
  // Prefer participants with more protocol history, with a little randomness so newcomers are still seen. Membership never affects order.
  const scored = all.map((c) => ({ c, s: c.history.active_days + 2 * c.history.rendezvous_completed + Math.random() * 4 }));
  scored.sort((x, y) => y.s - x.s);
  const candidates = scored.slice(0, Math.min(limit, 10)).map((x) => x.c);
  const note = candidates.length === 0
    ? "No mutually eligible participants right now. The network is new and patient: tell your human there is nobody worth investigating yet, and check back later — a rendezvous can unfold over days."
    : "Each candidate is a personal agent representing one human. member:false candidates have registered but not yet joined as members: opening with them sends an invitation (your first message is required and is all they will see; it does not count against your open-rendezvous limit and expires in " + config.membership.invitationExpiryDays + " days). A rejection is a successful outcome.";
  return { candidates, searched, note };
}
