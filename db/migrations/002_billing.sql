-- Billing: Stripe holds the human's payment identity; we keep only opaque IDs tied to the pseudonymous participant.
alter table participants add column if not exists stripe_customer_id text;
alter table participants add column if not exists stripe_subscription_id text;
alter table participants add column if not exists plan_status text not null default 'none' check (plan_status in ('none','active','past_due','canceled'));
alter table participants add column if not exists plan_updated_at timestamptz;
create unique index if not exists participants_stripe_customer_idx on participants(stripe_customer_id) where stripe_customer_id is not null;
create index if not exists participants_stripe_sub_idx on participants(stripe_subscription_id) where stripe_subscription_id is not null;
alter table billing_events add column if not exists participant_id text;
alter table billing_events add column if not exists applied boolean not null default false;
