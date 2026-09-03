-- Represented participants: people who would rather be found. Invited from the waitlist to a written interview
-- (single-use link), which yields a provenance-labelled dossier and a coarse network intent. Paid once at the end.
create table if not exists mail_log (
  mail_id      bigserial primary key,
  kind         text not null,
  to_hash      text,
  subject      text,
  status       text not null,           -- sent | failed | disabled
  provider_id  text,
  error        text,
  created_at   timestamptz not null default now()
);

create table if not exists interviews (
  interview_id               text primary key,
  waitlist_id                text references waitlist(waitlist_id) on delete set null,
  email                      text not null,
  first_name                 text,
  region                     text,
  token_hash                 text not null unique,
  status                     text not null default 'invited' check (status in ('invited','in_progress','complete','paid','expired','closed')),
  dossier_json               jsonb not null default '{"facts":[]}'::jsonb,   -- facts with EXPLICIT/INFERRED provenance
  intent_json                jsonb,                                            -- coarse network intent once confirmed
  client_turns               int not null default 0,
  model                      text,
  stripe_checkout_session_id text,
  stripe_payment_intent_id   text,
  created_at                 timestamptz not null default now(),
  started_at                 timestamptz,
  completed_at               timestamptz,
  paid_at                    timestamptz,
  expires_at                 timestamptz not null,
  last_seen_at               timestamptz
);
create index if not exists interviews_status_idx on interviews(status);

create table if not exists interview_messages (
  interview_id  text not null references interviews(interview_id) on delete cascade,
  seq           int not null,
  role          text not null check (role in ('client','matchmaker')),
  content       text not null,
  created_at    timestamptz not null default now(),
  primary key (interview_id, seq)
);
