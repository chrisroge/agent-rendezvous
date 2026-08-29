import type { Queryable } from "../db/pool.js";
import { pool } from "../db/pool.js";
import { config } from "../config.js";

export interface History {
  first_seen_days_ago: number;
  active_days: number;
  rendezvous_completed: number;
  unique_counterparties: number;
  good_faith_attestations: number;
  human_consent_events: number;
  blocks_received: number;
  reports_received: number;
  trust_state: "NEW" | "ESTABLISHED";
}

/**
 * Trust is evidence, not a score. Everything here is derived from protocol behaviour,
 * never from romantic outcomes (PRD §52: compatibility is not reputation).
 */
export async function historyFor(participantId: string, db: Queryable = pool): Promise<History> {
  const r = await db.query(
    `select
       greatest(0, (current_date - p.created_at::date))::int as first_seen_days_ago,
       (select count(*)::int from participant_activity_days d where d.participant_id = p.participant_id) as active_days,
       (select count(*)::int from rendezvous r where (r.participant_a = p.participant_id or r.participant_b = p.participant_id)
          and r.state = 'CLOSED' and r.outcome in ('MUTUAL_AFFINITY','NO_INTRODUCTION','DECLINED') and r.message_count >= 2) as rendezvous_completed,
       (select count(distinct case when r.participant_a = p.participant_id then r.participant_b else r.participant_a end)::int
          from rendezvous r where (r.participant_a = p.participant_id or r.participant_b = p.participant_id) and r.message_count >= 2) as unique_counterparties,
       (select count(*)::int from counterparty_assessments a where a.subject_id = p.participant_id and (a.assessment_json->>'good_faith')::boolean is true) as good_faith_attestations,
       (select count(*)::int from trust_events t where t.participant_id = p.participant_id and t.event_type = 'human_consent') as human_consent_events,
       (select count(*)::int from blocks b where b.blocked_id = p.participant_id) as blocks_received,
       (select count(*)::int from reports rp where rp.subject_id = p.participant_id and rp.review_state <> 'dismissed') as reports_received
     from participants p where p.participant_id = $1`,
    [participantId],
  );
  const row = r.rows[0] ?? { first_seen_days_ago: 0, active_days: 0, rendezvous_completed: 0, unique_counterparties: 0,
    good_faith_attestations: 0, human_consent_events: 0, blocks_received: 0, reports_received: 0 };
  const established = row.active_days >= config.limits.establishedActiveDays && row.rendezvous_completed >= config.limits.establishedCompletedRendezvous;
  return { ...row, trust_state: established ? "ESTABLISHED" : "NEW" };
}
