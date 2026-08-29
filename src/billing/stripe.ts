import type { Request, Response } from "express";
import Stripe from "stripe";
import { pool } from "../db/pool.js";
import { config } from "../config.js";

/**
 * Stripe webhook receiver — V1 monetization scaffold. Day Zero participation is free (PRD §58),
 * so this only verifies signatures and records events until a paid tier exists.
 */
const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

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
  await pool.query("insert into billing_events(event_id, event_type, payload) values ($1,$2,$3) on conflict do nothing",
    [event.id, event.type, JSON.stringify(event)]);
  res.json({ received: true });
}

export const billingConfigured = () => Boolean(stripe && config.stripeWebhookSecret);
