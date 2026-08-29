import { pool } from "../db/pool.js";
import { E } from "../errors.js";
import { mutuallyEligible, publicIntentView, type Intent } from "./eligibility.js";
import { activeRendezvousCount, countRecent, getIntent, limitsFor, rowToIntent, type Participant } from "../participants/service.js";
import { historyFor, type History } from "../trust/evidence.js";

export interface Candidate {
  candidate_id: string;
  history: History;
  coarse_facts: ReturnType<typeof publicIntentView>;
}

/**
 * Candidate generation: deterministic server-side filtering only.
 * Excludes self, blocked pairs (either direction), pairs with an existing non-expired rendezvous,
 * inactive participants, and counterparties already at their active-rendezvous cap.
 */
export async function eligibleCandidates(me: Participant, myIntent: Intent): Promise<Candidate[]> {
  const r = await pool.query(
    `select i.* from match_intents i
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
    const history = await historyFor(intent.participant_id);
    const cap = limitsFor(history.trust_state).max_active_rendezvous;
    if ((await activeRendezvousCount(intent.participant_id)) >= cap) continue;
    out.push({ candidate_id: intent.participant_id, history, coarse_facts: publicIntentView(intent) });
  }
  return out;
}

export async function discover(me: Participant, limit: number, minimumHistory: "any" | "established"): Promise<{
  candidates: Candidate[]; searched: number; note: string;
}> {
  const myIntent = await getIntent(me.participant_id);
  if (!myIntent) throw E.invalid("You have no active matchmaking intent. Call join with an intent first.");
  const myHistory = await historyFor(me.participant_id);
  const limits = limitsFor(myHistory.trust_state);
  if ((await countRecent(me.participant_id, "discover", "1 day")) >= limits.discover_per_day) {
    throw E.rateLimited(`${limits.discover_per_day} discovery requests per day for ${myHistory.trust_state} participants`);
  }
  const active = await activeRendezvousCount(me.participant_id);
  if (active >= limits.max_active_rendezvous) {
    return { candidates: [], searched: 0, note: `You already have ${active} open rendezvous (your limit is ${limits.max_active_rendezvous}). Conclude one before discovering more.` };
  }
  let all = await eligibleCandidates(me, myIntent);
  const searched = all.length;
  if (minimumHistory === "established") all = all.filter((c) => c.history.trust_state === "ESTABLISHED");
  // Prefer participants with more protocol history, with a little randomness so newcomers are still seen.
  const scored = all.map((c) => ({ c, s: c.history.active_days + 2 * c.history.rendezvous_completed + Math.random() * 4 }));
  scored.sort((x, y) => y.s - x.s);
  const candidates = scored.slice(0, Math.min(limit, limits.max_active_rendezvous - active)).map((x) => x.c);
  const note = candidates.length === 0
    ? "No mutually eligible participants right now. The network is new and patient: tell your human there is nobody worth investigating yet, and check back later (status/discover) — a rendezvous can unfold over days."
    : "Each candidate is a personal agent representing one human. Review the history evidence, then open a rendezvous with rendezvous_open. A rejection is a successful outcome.";
  return { candidates, searched, note };
}
