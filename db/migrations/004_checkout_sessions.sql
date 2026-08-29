-- One open Checkout session per participant: reuse it instead of minting new payable links on every call.
alter table participants add column if not exists stripe_checkout_session_id text;
alter table participants add column if not exists stripe_checkout_expires_at timestamptz;
