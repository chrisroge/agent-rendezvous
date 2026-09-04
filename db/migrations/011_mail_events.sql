-- Delivery truth. An SMTP relay accepting a message is not delivery: Postmark accepted our first test over SMTP and
-- then rejected it asynchronously. Webhook events record what actually happened, and addresses that hard-bounce or
-- report spam are suppressed so we never mail them again (repeat sends to dead addresses are what wrecks a sender's
-- reputation, which is the whole reason this service exists on a relay).
alter table mail_log add column if not exists provider_response text;

create table if not exists mail_suppressions (
  email_hash  text primary key,
  reason      text not null check (reason in ('hard_bounce','spam_complaint','manual')),
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists mail_log_status_idx on mail_log(status, created_at);
