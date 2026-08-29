import type { Request, Response } from "express";
import Stripe from "stripe";
import { pool, withTx } from "../db/pool.js";
import { config } from "../config.js";
import { RvzError } from "../errors.js";
import { limitsFor, type Participant } from "../participants/service.js";
import { historyFor } from "../trust/evidence.js";

/**
 * Billing (PRD §58): free at Day Zero; a paid plan buys matchmaking *work* (more parallel rendezvous, more discovery),
 * never rank, visibility or "who liked you". There is no human account, so the flow is:
 *   agent calls `billing` (checkout) → Stripe Checkout URL tied to participant_id → agent hands URL to its human →
 *   human pays on Stripe → webhook flips participant.plan. We store only opaque Stripe IDs; never card or email.
 * Everything here is inert until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID are configured.
 */
const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

export const billingEnabled = () => Boolean(stripe && config.stripeWebhookSecret && config.stripePriceId);

const unavailable = () => new RvzError("BILLING_UNAVAILABLE", "Rendezvous is free during the Day-Zero network. Paid plans are not available yet; your current limits apply.");

async function stripeCall<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    const err = e as Stripe.errors.StripeError;
    console.error(JSON.stringify({ level: "error", msg: "stripe error", type: err.type, code: err.code, message: err.message }));
    throw new RvzError("BILLING_ERROR", "The billing provider returned an error. Nothing was charged. Try again later.");
  }
}

export async function billingStatus(p: Participant) {
  const history = await historyFor(p.participant_id);
  return {
    billing_enabled: billingEnabled(),
    plan: p.plan,
    plan_status: p.plan_status,
    limits: limitsFor(history.trust_state, p.plan),
    plus_would_give: limitsFor(history.trust_state, "plus"),
    principles: "Paid plans buy matchmaking work (parallel rendezvous, discovery, opens). They never buy ranking, visibility, or information about who liked whom.",
  };
}

/** Create (or reuse) a Stripe customer for this participant. No email, no name — Stripe collects those at checkout. */
async function customerFor(p: Participant): Promise<string> {
  if (p.stripe_customer_id) return p.stripe_customer_id;
  const customer = await stripeCall(() => stripe!.customers.create({ metadata: { participant_id: p.participant_id } }));
  await pool.query("update participants set stripe_customer_id = $2 where participant_id = $1 and stripe_customer_id is null", [p.participant_id, customer.id]);
  const r = await pool.query("select stripe_customer_id from participants where participant_id = $1", [p.participant_id]);
  return r.rows[0].stripe_customer_id as string; // whoever won the race
}

export async function createCheckout(p: Participant) {
  if (!billingEnabled()) throw unavailable();
  if (p.plan === "plus" && p.plan_status === "active") throw new RvzError("CONFLICT", "This participant is already on Plus. Use billing action 'portal' to manage the subscription.");
  const customer = await customerFor(p);
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
  return {
    checkout_url: session.url,
    expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    instructions: "Give this URL to your human. Never enter payment details yourself. The plan activates automatically once Stripe confirms payment; call billing (status) or status afterwards to see the new limits.",
  };
}

export async function createPortal(p: Participant) {
  if (!billingEnabled()) throw unavailable();
  if (!p.stripe_customer_id) throw new RvzError("NOT_FOUND", "No billing relationship exists for this participant yet. Use billing action 'checkout' first.");
  const session = await stripeCall(() => stripe!.billingPortal.sessions.create({
    customer: p.stripe_customer_id!,
    return_url: `${config.publicUrl}/billing/success`,
    ...(config.stripePortalConfigId ? { configuration: config.stripePortalConfigId } : {}),
  }));
  return { portal_url: session.url, instructions: "Give this URL to your human to manage, change or cancel the subscription." };
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook

function planFromSubscriptionStatus(status: Stripe.Subscription.Status): { plan: "free" | "plus"; plan_status: Participant["plan_status"] } {
  switch (status) {
    case "active": case "trialing": return { plan: "plus", plan_status: "active" };
    case "past_due": case "unpaid": case "incomplete": return { plan: "plus", plan_status: "past_due" };
    default: return { plan: "free", plan_status: "canceled" }; // canceled, incomplete_expired, paused
  }
}

async function setPlan(tx: { query: typeof pool.query }, participantId: string, plan: "free" | "plus", planStatus: Participant["plan_status"], subscriptionId: string | null) {
  await tx.query(
    "update participants set plan = $2, plan_status = $3, stripe_subscription_id = coalesce($4, stripe_subscription_id), plan_updated_at = now() where participant_id = $1",
    [participantId, plan, planStatus, subscriptionId],
  );
}

async function participantForCustomer(tx: { query: typeof pool.query }, customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const r = await tx.query("select participant_id from participants where stripe_customer_id = $1", [customerId]);
  return (r.rows[0]?.participant_id as string | undefined) ?? null;
}

/** Apply one verified event. Returns the participant it touched, if any. Idempotent by event id (billing_events PK). */
export async function applyEvent(event: Stripe.Event): Promise<{ duplicate: boolean; participant_id: string | null; applied: boolean }> {
  return withTx(async (tx) => {
    const ins = await tx.query("insert into billing_events(event_id, event_type, payload) values ($1,$2,$3) on conflict do nothing", [event.id, event.type, JSON.stringify(event)]);
    if (!ins.rowCount) return { duplicate: true, participant_id: null, applied: false };
    let participantId: string | null = null, applied = false;
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        participantId = (s.metadata?.participant_id ?? s.client_reference_id ?? null) || (await participantForCustomer(tx, typeof s.customer === "string" ? s.customer : s.customer?.id));
        if (participantId && s.mode === "subscription") {
          const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id ?? null;
          const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
          if (customerId) await tx.query("update participants set stripe_customer_id = coalesce(stripe_customer_id, $2) where participant_id = $1", [participantId, customerId]);
          await setPlan(tx, participantId, "plus", "active", subId);
          applied = true;
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        participantId = sub.metadata?.participant_id || (await participantForCustomer(tx, typeof sub.customer === "string" ? sub.customer : sub.customer?.id));
        if (participantId) {
          const { plan, plan_status } = event.type === "customer.subscription.deleted" ? { plan: "free" as const, plan_status: "canceled" as const } : planFromSubscriptionStatus(sub.status);
          await setPlan(tx, participantId, plan, plan_status, sub.id);
          applied = true;
        }
        break;
      }
      default:
        break; // recorded, not acted on
    }
    await tx.query("update billing_events set participant_id = $2, applied = $3 where event_id = $1", [event.id, participantId, applied]);
    return { duplicate: false, participant_id: participantId, applied };
  });
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
