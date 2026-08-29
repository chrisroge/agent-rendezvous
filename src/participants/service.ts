import type { Queryable } from "../db/pool.js";
import { pool, withTx } from "../db/pool.js";
import { E, RvzError } from "../errors.js";
import { hashSecret, newId, newSecret } from "./ids.js";
import { normalizeIntent, type IntentInput, type Intent } from "../discovery/eligibility.js";
import { config } from "../config.js";

export interface Participant {
  participant_id: string;
  status: "active" | "withdrawn" | "disabled";
  created_at: Date;
  last_seen_at: Date;
  plan: "free" | "member";
  plan_status: "none" | "active" | "past_due" | "canceled" | "paused" | "comped";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_checkout_expires_at: Date | null;
}

/** Membership = may participate (discover, open, send, recommend, assess). past_due keeps membership through Stripe's retry window. */
export function isMember(p: Pick<Participant, "plan" | "plan_status">): boolean {
  return p.plan === "member" && (p.plan_status === "active" || p.plan_status === "past_due" || p.plan_status === "comped");
}

export async function isNetworkPaused(db: Queryable = pool): Promise<boolean> {
  const r = await db.query("select value from settings where key = 'network_paused'");
  return r.rows[0]?.value === true;
}

/** Resolve a secret to a participant. Throws typed errors for the agent. */
export async function authenticate(secret: string | undefined, opts: { allowWithdrawn?: boolean } = {}): Promise<Participant> {
  if (!secret) throw E.unauthenticated();
  if (!/^rv_live_[A-Za-z0-9_-]{20,}$/.test(secret)) throw E.invalidSecret();
  const r = await pool.query<Participant>(
    "select participant_id, status, created_at, last_seen_at, plan, plan_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_checkout_session_id, stripe_checkout_expires_at from participants where secret_hash = $1",
    [hashSecret(secret)],
  );
  const p = r.rows[0];
  if (!p) throw E.invalidSecret();
  if (p.status === "disabled") throw E.disabled();
  if (p.status === "withdrawn" && !opts.allowWithdrawn) throw E.withdrawn();
  await touch(p.participant_id);
  return p;
}

/** Record activity (last_seen + activity-day continuity). */
export async function touch(participantId: string, db: Queryable = pool): Promise<void> {
  await db.query("update participants set last_seen_at = now() where participant_id = $1", [participantId]);
  await db.query(
    "insert into participant_activity_days(participant_id, day) values ($1, current_date) on conflict do nothing",
    [participantId],
  );
}

export async function trustEvent(
  db: Queryable,
  participantId: string,
  eventType: string,
  extra: { source?: string; rendezvousId?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  await db.query(
    `insert into trust_events(participant_id, event_type, source_participant_id, rendezvous_id, metadata)
     values ($1, $2, $3, $4, $5)`,
    [participantId, eventType, extra.source ?? null, extra.rendezvousId ?? null, JSON.stringify(extra.metadata ?? {})],
  );
}

export interface JoinResult {
  participant_id: string;
  participant_secret?: string;
  is_new: boolean;
  intent: Intent | null;
}

/**
 * join: create a new participant (no secret supplied) or resume an existing one, and publish/replace intent.
 * A withdrawn participant re-activates by joining again.
 */
export async function join(secret: string | undefined, intentInput: IntentInput | undefined, clientInfo: Record<string, unknown>): Promise<JoinResult> {
  const intent = intentInput ? normalizeIntent(intentInput) : null;
  if (secret) {
    const p = await authenticate(secret, { allowWithdrawn: true });
    return withTx(async (tx) => {
      if (p.status === "withdrawn") {
        await tx.query("update participants set status = 'active', withdrawn_at = null where participant_id = $1", [p.participant_id]);
        await trustEvent(tx, p.participant_id, "rejoined");
      }
      await tx.query("update participants set client_info = client_info || $2::jsonb where participant_id = $1", [p.participant_id, JSON.stringify(clientInfo)]);
      const stored = intent ? await replaceIntent(tx, p.participant_id, intent) : await getIntent(p.participant_id, tx);
      return { participant_id: p.participant_id, is_new: false, intent: stored };
    });
  }
  if (!intent) throw E.invalid("A new participant must supply an intent (represented_gender, seeking_gender, age band, relationship_intent, region).");
  const newSecretValue = newSecret();
  const participantId = newId("pt");
  return withTx(async (tx) => {
    await tx.query(
      "insert into participants(participant_id, secret_hash, client_info) values ($1, $2, $3)",
      [participantId, hashSecret(newSecretValue), JSON.stringify(clientInfo)],
    );
    await tx.query("insert into participant_activity_days(participant_id, day) values ($1, current_date) on conflict do nothing", [participantId]);
    await trustEvent(tx, participantId, "joined");
    const stored = await replaceIntent(tx, participantId, intent);
    return { participant_id: participantId, participant_secret: newSecretValue, is_new: true, intent: stored };
  });
}

async function replaceIntent(tx: Queryable, participantId: string, intent: Intent): Promise<Intent> {
  await tx.query("update match_intents set active = false, updated_at = now() where participant_id = $1 and active", [participantId]);
  const intentId = newId("int");
  await tx.query(
    `insert into match_intents(intent_id, participant_id, represented_gender, represented_age_min, represented_age_max,
       seeking_genders, preferred_age_min, preferred_age_max, relationship_intent, region, region_normalized, radius_miles,
       coarse_lat, coarse_lon, attributes, exclusions)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [intentId, participantId, intent.represented_gender, intent.represented_age_min, intent.represented_age_max,
      intent.seeking_genders, intent.preferred_age_min, intent.preferred_age_max, intent.relationship_intent,
      intent.region, intent.region_normalized, intent.radius_miles, intent.coarse_lat, intent.coarse_lon,
      intent.attributes, intent.exclusions],
  );
  await trustEvent(tx, participantId, "intent_updated");
  return { ...intent, participant_id: participantId };
}

export async function getIntent(participantId: string, db: Queryable = pool): Promise<Intent | null> {
  const r = await db.query("select * from match_intents where participant_id = $1 and active", [participantId]);
  return r.rows[0] ? rowToIntent(r.rows[0]) : null;
}

export function rowToIntent(row: Record<string, unknown>): Intent {
  return {
    participant_id: row.participant_id as string,
    represented_gender: row.represented_gender as string,
    represented_age_min: row.represented_age_min as number,
    represented_age_max: row.represented_age_max as number,
    seeking_genders: row.seeking_genders as string[],
    preferred_age_min: row.preferred_age_min as number,
    preferred_age_max: row.preferred_age_max as number,
    relationship_intent: row.relationship_intent as string[],
    region: row.region as string,
    region_normalized: row.region_normalized as string,
    radius_miles: row.radius_miles as number,
    coarse_lat: (row.coarse_lat as number | null) ?? null,
    coarse_lon: (row.coarse_lon as number | null) ?? null,
    attributes: row.attributes as string[],
    exclusions: row.exclusions as string[],
  };
}

/** Withdraw: deactivate intent, close open rendezvous, mark withdrawn. Identity is retained so the secret still resumes it. */
export async function withdraw(participantId: string, reason: string | undefined): Promise<{ closed_rendezvous: number }> {
  return withTx(async (tx) => {
    await tx.query("update match_intents set active = false, updated_at = now() where participant_id = $1 and active", [participantId]);
    const r = await tx.query(
      `update rendezvous set state = 'CLOSED', phase = 'CLOSED', outcome = 'WITHDRAWN', closed_at = now(), closed_by = $1, updated_at = now()
       where state = 'OPEN' and (participant_a = $1 or participant_b = $1) returning rendezvous_id`,
      [participantId],
    );
    await tx.query("update participants set status = 'withdrawn', withdrawn_at = now() where participant_id = $1", [participantId]);
    await trustEvent(tx, participantId, "withdrew", { metadata: { reason: reason ?? null } });
    return { closed_rendezvous: r.rowCount ?? 0 };
  });
}

/** Simple sliding-window rate limits derived from the audit log. */
export async function countRecent(participantId: string, tool: string, interval: string): Promise<number> {
  const r = await pool.query(
    `select count(*)::int as n from audit_log where participant_id = $1 and tool = $2 and ok and created_at > now() - $3::interval`,
    [participantId, tool, interval],
  );
  return r.rows[0].n as number;
}

export async function activeRendezvousCount(participantId: string, db: Queryable = pool): Promise<number> {
  const r = await db.query(
    "select count(*)::int as n from rendezvous where state = 'OPEN' and kind = 'rendezvous' and (participant_a = $1 or participant_b = $1)",
    [participantId],
  );
  return r.rows[0].n as number;
}

/** Operational limits. Trust tier sets them (anti-abuse and counterparty protection). Membership is the door, not a capacity lever. */
export function limitsFor(trustState: string) {
  const est = trustState === "ESTABLISHED";
  return {
    max_active_rendezvous: est ? config.limits.establishedMaxActiveRendezvous : config.limits.newMaxActiveRendezvous,
    discover_per_day: est ? config.limits.establishedDiscoverPerDay : config.limits.newDiscoverPerDay,
    opens_per_day: config.limits.maxOpensPerDay,
    sends_per_hour: config.limits.maxSendsPerHour,
    max_message_chars: config.limits.maxMessageChars,
    max_messages_per_rendezvous: config.limits.maxMessagesPerRendezvous,
    max_consecutive_messages: config.limits.maxConsecutiveMessages,
    min_messages_each_before_yes: config.limits.minMessagesEachForYes,
    rendezvous_expiry_days: config.limits.rendezvousExpiryDays,
    invitation_expiry_days: config.membership.invitationExpiryDays,
    invitations_pending_max: config.membership.invitationsPendingMax,
  };
}

export { RvzError };
