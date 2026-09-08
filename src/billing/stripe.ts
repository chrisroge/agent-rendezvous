import type { Request, Response } from "express";
import Stripe from "stripe";
import { pool, withTx } from "../db/pool.js";
import { config } from "../config.js";
import { RvzError } from "../errors.js";
import { isMember, type Participant } from "../participants/service.js";
import { membershipTerms } from "../pricing.js";

/**
 * Membership billing. Seekers pay a monthly membership (see config.pricing); founding members who joined at the original price keep it.
 * Free to register and watch; membership to search and talk.
 * There is no human account, so the flow is: agent calls `billing` (checkout) → Stripe Checkout URL tied to participant_id →
 * agent hands the URL to its human → human pays on Stripe → webhook sets participants.plan. Humans can also pay directly via
 * the Payment Link on /pricing, entering their participant_id as a custom field. We store only opaque Stripe IDs; never card or email.
 * Collection is paused while a participant is withdrawn and resumed on rejoin: you pay only while your agent is searching.
 * Everything here is inert until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID are configured.
 */
const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

export const billingEnabled = () => Boolean(stripe && config.stripeWebhookSecret && config.stripePriceId);
const price = () => config.membership.priceText;
const unavailable = () => new RvzError("BILLING_UNAVAILABLE", "Membership checkout is not available yet on this network. Registration and watching are free; keep checking status.");

function isStripeError(e: unknown): e is Stripe.errors.StripeError { return typeof e === "object" && e !== null && "type" in e && typeof (e as any).type === "string"; }

async function stripeCall<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    const err = e as Stripe.errors.StripeError;
    console.error(JSON.stringify({ level: "error", msg: "stripe error", type: err.type, code: err.code, param: (err as any).param, message: err.message }));
    const code = err.code ?? err.type ?? "unknown";
    const transient = ["rate_limit_error", "api_connection_error", "api_error", "lock_timeout"].includes(String(err.type)) || String(err.code) === "lock_timeout";
    throw new RvzError("BILLING_ERROR", transient
      ? `The billing provider is temporarily unavailable (${code}). Nothing was charged. Try again in a few minutes.`
      : `The billing provider rejected the request (${code}). Nothing was charged. This is not something a retry will fix; tell your human and mention the code — the operator can see the full error in the logs.`, { stripe_code: code });
  }
}

export function membershipView(p: Participant) {
  return {
    active: isMember(p),
    status: p.plan_status,
    founding_member: isMember(p) && !!p.stripe_price_id && p.stripe_price_id === config.stripeFounderPriceId,
    price: price(),
    included_rendezvous_per_month: null,
    extra_rendezvous: "Not available during the pilot",
    founding_members_keep_original_price: true,
    pay_only_while_searching: true,
  };
}

export async function billingStatus(p: Participant) {
  return {
    billing_enabled: billingEnabled(),
    membership: membershipView(p),
    pricing_page: `${config.publicUrl}/pricing`,
    principles: "Membership is the door: it lets you search and talk. It never buys ranking, visibility, or information about who liked whom, and it is not visible to other participants. Registering, watching, reading invitations in full, and declining are always free. Collection pauses while you are withdrawn.",
  };
}

/**
 * Create (or reuse) a Stripe customer for this participant. No email, no name — Stripe collects those at checkout.
 * A stored customer that no longer exists on this account (deleted, or created under a previous Stripe account) is reset.
 */
async function customerFor(p: Participant): Promise<string> {
  if (p.stripe_customer_id) {
    try {
      const c = await stripe!.customers.retrieve(p.stripe_customer_id);
      if (!("deleted" in c && c.deleted)) return p.stripe_customer_id;
    } catch (e) {
      if (!(isStripeError(e) && e.code === "resource_missing")) return stripeCall(() => Promise.reject(e));
    }
    console.error(JSON.stringify({ level: "warn", msg: "stale stripe customer reset", participant: p.participant_id, customer: p.stripe_customer_id }));
    await pool.query("update participants set stripe_customer_id = null, stripe_subscription_id = null, stripe_checkout_session_id = null, stripe_checkout_expires_at = null where participant_id = $1 and stripe_customer_id = $2", [p.participant_id, p.stripe_customer_id]);
    p = { ...p, stripe_customer_id: null, stripe_subscription_id: null, stripe_checkout_session_id: null, stripe_checkout_expires_at: null };
  }
  const customer = await stripeCall(() => stripe!.customers.create({ metadata: { participant_id: p.participant_id } }));
  await pool.query("update participants set stripe_customer_id = $2 where participant_id = $1 and stripe_customer_id is null", [p.participant_id, customer.id]);
  const r = await pool.query("select stripe_customer_id from participants where participant_id = $1", [p.participant_id]);
  return r.rows[0].stripe_customer_id as string; // whoever won the race
}

export async function createCheckout(p: Participant) {
  if (!billingEnabled()) throw unavailable();
  if (isMember(p)) throw new RvzError("CONFLICT", "This participant is already a member. Use billing action 'portal' to manage the subscription.");
  if (p.plan_status === "paused" && p.stripe_subscription_id) {
    // A withdrawn-then-rejoined member whose resume failed: resume rather than create a second subscription.
    await resumeCollection(p);
    return { resumed: true, instructions: "Your paused membership has been resumed. Call status to confirm." };
  }
  const customer = await customerFor(p);
  // Reuse the participant's open session rather than minting another payable link on every call.
  if (p.stripe_checkout_session_id && p.stripe_checkout_expires_at && new Date(p.stripe_checkout_expires_at) > new Date()) {
    try {
      const existing = await stripe!.checkout.sessions.retrieve(p.stripe_checkout_session_id);
      if (existing.status === "open" && existing.url && existing.customer === customer) {
        return { checkout_url: existing.url, expires_at: existing.expires_at ? new Date(existing.expires_at * 1000).toISOString() : null, reused: true,
          instructions: "This is the same Checkout link as before (one open session per participant). Give it to your human — never enter payment details yourself." };
      }
    } catch { /* not retrievable on this account or already gone: create a fresh one */ }
  }
  const session = await stripeCall(() => stripe!.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: config.stripePriceId, quantity: 1 }],
    client_reference_id: p.participant_id,
    metadata: { participant_id: p.participant_id },
    subscription_data: { metadata: { participant_id: p.participant_id } },
    allow_promotion_codes: true,
    success_url: `${config.publicUrl}/billing/success`,
    cancel_url: `${config.publicUrl}/billing/cancel`,
  }));
  await pool.query("update participants set stripe_checkout_session_id = $2, stripe_checkout_expires_at = $3 where participant_id = $1",
    [p.participant_id, session.id, session.expires_at ? new Date(session.expires_at * 1000) : null]);
  return {
    checkout_url: session.url,
    expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    reused: false,
    instructions: `Give this URL to your human — never enter payment details yourself. Membership is ${membershipTerms()}. It activates automatically once Stripe confirms payment; call status afterwards.`,
  };
}

/** One-time be-found payment at the end of a completed interview. Keyed by interview id in metadata; the webhook marks it paid. */
export async function createRepresentedCheckout(interviewId: string, token: string): Promise<{ url: string | null; expires_at: string | null }> {
  if (!stripe || !config.stripeWebhookSecret || !config.stripeRepresentedPriceId) throw new RvzError("BILLING_UNAVAILABLE", "Payment isn't available yet. Your interview is saved.");
  const cur = await pool.query("select stripe_checkout_session_id from interviews where interview_id = $1", [interviewId]);
  if (cur.rows[0]?.stripe_checkout_session_id) {
    try { const s = await stripe.checkout.sessions.retrieve(cur.rows[0].stripe_checkout_session_id); if (s.status === "open" && s.url) return { url: s.url, expires_at: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : null }; } catch { /* mint a new one */ }
  }
  const session = await stripeCall(() => stripe!.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: config.stripeRepresentedPriceId, quantity: 1 }],
    client_reference_id: interviewId,
    metadata: { interview_id: interviewId, project: "rendezvous", side: "represented" },
    payment_intent_data: { metadata: { interview_id: interviewId }, statement_descriptor: "RENDEZVOUS" },
    allow_promotion_codes: true,
    success_url: `${config.publicUrl}/interview/${token}?paid=1`,
    cancel_url: `${config.publicUrl}/interview/${token}`,
  }));
  await pool.query("update interviews set stripe_checkout_session_id = $2 where interview_id = $1", [interviewId, session.id]);
  return { url: session.url, expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null };
}

export async function createPortal(p: Participant) {
  if (!billingEnabled()) throw unavailable();
  if (!p.stripe_customer_id) throw new RvzError("NOT_FOUND", "No billing relationship exists for this participant yet. Use billing action 'checkout' first.");
  const customer = await customerFor(p);
  const session = await stripeCall(() => stripe!.billingPortal.sessions.create({
    customer,
    return_url: `${config.publicUrl}/billing/success`,
    ...(config.stripePortalConfigId ? { configuration: config.stripePortalConfigId } : {}),
  }));
  return { portal_url: session.url, instructions: "Give this URL to your human to manage, change or cancel the membership." };
}

/** Withdraw → stop charging. Best effort: a Stripe failure must not block the withdrawal; the operator sees it in the logs. */
export async function pauseCollection(p: Participant): Promise<boolean> {
  if (!stripe || !p.stripe_subscription_id || !(p.plan_status === "active" || p.plan_status === "past_due")) return false;
  try {
    await stripe.subscriptions.update(p.stripe_subscription_id, { pause_collection: { behavior: "void" } });
    await pool.query("update participants set plan_status = 'paused', plan_updated_at = now() where participant_id = $1", [p.participant_id]);
    return true;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "pause_collection failed", participant: p.participant_id, error: (e as Error).message }));
    return false;
  }
}

/** Rejoin → resume charging. */
export async function resumeCollection(p: Participant): Promise<boolean> {
  if (!stripe || !p.stripe_subscription_id || p.plan_status !== "paused") return false;
  try {
    await stripe.subscriptions.update(p.stripe_subscription_id, { pause_collection: null as unknown as undefined });
    await pool.query("update participants set plan = 'member', plan_status = 'active', plan_updated_at = now() where participant_id = $1", [p.participant_id]);
    return true;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "resume collection failed", participant: p.participant_id, error: (e as Error).message }));
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook

function planFromSubscription(sub: Stripe.Subscription): { plan: "free" | "member"; plan_status: Participant["plan_status"] } {
  if (sub.pause_collection) return { plan: "member", plan_status: "paused" };
  switch (sub.status) {
    case "active": case "trialing": return { plan: "member", plan_status: "active" };
    case "past_due": case "unpaid": case "incomplete": return { plan: "member", plan_status: "past_due" };
    case "paused": return { plan: "member", plan_status: "paused" };
    default: return { plan: "free", plan_status: "canceled" }; // canceled, incomplete_expired
  }
}

type Tx = { query: typeof pool.query };

async function setPlan(tx: Tx, participantId: string, plan: "free" | "member", planStatus: Participant["plan_status"], subscriptionId: string | null, priceId: string | null): Promise<boolean> {
  const r = await tx.query(
    `update participants set plan = $2, plan_status = $3, stripe_subscription_id = coalesce($4, stripe_subscription_id),
       stripe_price_id = coalesce($5, stripe_price_id), plan_updated_at = now() where participant_id = $1`,
    [participantId, plan, planStatus, subscriptionId, priceId],
  );
  return (r.rowCount ?? 0) > 0;
}

async function participantForCustomer(tx: Tx, customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const r = await tx.query("select participant_id from participants where stripe_customer_id = $1", [customerId]);
  return (r.rows[0]?.participant_id as string | undefined) ?? null;
}

function customFieldParticipant(s: Stripe.Checkout.Session): string | null {
  const f = (s.custom_fields ?? []).find((x) => x.key === "participant_id");
  const v = f?.text?.value?.trim();
  return v && /^pt_[0-9A-Z]{20,32}$/.test(v) ? v : null;
}

/** Apply one verified event. Idempotent by event id (billing_events PK). */
export async function applyEvent(event: Stripe.Event): Promise<{ duplicate: boolean; participant_id: string | null; applied: boolean }> {
  const result = await withTx(async (tx) => {
    const ins = await tx.query("insert into billing_events(event_id, event_type, payload) values ($1,$2,$3) on conflict do nothing", [event.id, event.type, JSON.stringify(event)]);
    if (!ins.rowCount) return { duplicate: true, participant_id: null, applied: false, linkSubscription: null as null | { sub: string; participant: string } };
    let participantId: string | null = null, applied = false, linkSubscription: null | { sub: string; participant: string } = null;
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
        const viaField = customFieldParticipant(s);
        participantId = (s.metadata?.participant_id ?? s.client_reference_id ?? null) || viaField || (await participantForCustomer(tx, customerId));
        if (s.mode === "payment" && s.metadata?.interview_id) {
          if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") break;
          const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null;
          const r = await tx.query("update interviews set status = 'paid', paid_at = coalesce(paid_at, now()), stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id) where interview_id = $1 and status in ('complete','paid') returning waitlist_id", [s.metadata.interview_id, pi]);
          if (r.rowCount && r.rows[0].waitlist_id) await tx.query("update waitlist set status = 'joined' where waitlist_id = $1", [r.rows[0].waitlist_id]);
          applied = (r.rowCount ?? 0) > 0;
          participantId = null;
          break;
        }
        if (participantId && s.mode === "subscription") {
          if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") break;
          const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id ?? null;
          if (customerId) await tx.query("update participants set stripe_customer_id = coalesce(stripe_customer_id, $2) where participant_id = $1", [participantId, customerId]);
          applied = await setPlan(tx, participantId, "member", "active", subId, null);
          await tx.query("update participants set stripe_checkout_session_id = null, stripe_checkout_expires_at = null where participant_id = $1", [participantId]);
          if (applied && subId && viaField && !s.metadata?.participant_id) linkSubscription = { sub: subId, participant: participantId };
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        let sub = event.data.object as Stripe.Subscription;
        // Reconcile the current provider object rather than replaying an obsolete snapshot.
        // Synthetic in-process campaign fixtures omit livemode and have no provider object.
        if (stripe && typeof event.livemode === "boolean") {
          await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["stripe:" + sub.id]);
          sub = await stripe.subscriptions.retrieve(sub.id);
        }
        participantId = sub.metadata?.participant_id || (await participantForCustomer(tx, typeof sub.customer === "string" ? sub.customer : sub.customer?.id));
        if (participantId) {
          const priceId = sub.items?.data?.[0]?.price?.id ?? null;
          const { plan, plan_status } = planFromSubscription(sub);
          applied = await setPlan(tx, participantId, plan, plan_status, sub.id, priceId);
        }
        break;
      }
      default:
        break; // recorded, not acted on
    }
    await tx.query("update billing_events set participant_id = $2, applied = $3 where event_id = $1", [event.id, participantId, applied]);
    return { duplicate: false, participant_id: participantId, applied, linkSubscription };
  });
  // Payment-link purchases carry the participant only in a custom field: tag the subscription so later events map without a customer lookup.
  if (result.linkSubscription && stripe) {
    stripe.subscriptions.update(result.linkSubscription.sub, { metadata: { participant_id: result.linkSubscription.participant } })
      .catch((e) => console.error(JSON.stringify({ level: "error", msg: "subscription metadata link failed", error: (e as Error).message })));
  }
  const { linkSubscription: _l, ...out } = result;
  return out;
}

export async function stripeWebhook(req: Request, res: Response): Promise<void> {
  if (!stripe || !config.stripeWebhookSecret) { res.status(503).json({ error: "billing not configured" }); return; }
  const sig = req.header("stripe-signature");
  if (!sig) { res.status(400).json({ error: "missing signature" }); return; }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, config.stripeWebhookSecret);
  } catch (e) {
    res.status(400).json({ error: `signature verification failed: ${(e as Error).message}` });
    return;
  }
  const result = await applyEvent(event);
  res.json({ received: true, ...result });
}
