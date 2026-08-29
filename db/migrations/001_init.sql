-- Rendezvous V0 schema. Neutral primitives: participant, intent, candidate, rendezvous, recommendation.

create table if not exists participants (
  participant_id   text primary key,
  secret_hash      text not null unique,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  status           text not null default 'active' check (status in ('active','withdrawn','disabled')),
  withdrawn_at     timestamptz,
  disabled_at      timestamptz,
  disabled_reason  text,
  client_info      jsonb not null default '{}'::jsonb,
  plan             text not null default 'free'
);

create table if not exists participant_activity_days (
  participant_id   text not null references participants(participant_id) on delete cascade,
  day              date not null,
  primary key (participant_id, day)
);

create table if not exists match_intents (
  intent_id            text primary key,
  participant_id       text not null references participants(participant_id) on delete cascade,
  represented_gender   text not null,
  represented_age_min  int  not null,
  represented_age_max  int  not null,
  seeking_genders      text[] not null,
  preferred_age_min    int  not null,
  preferred_age_max    int  not null,
  relationship_intent  text[] not null,
  region               text not null,
  region_normalized    text not null,
  radius_miles         int  not null default 50,
  coarse_lat           double precision,
  coarse_lon           double precision,
  attributes           text[] not null default '{}',
  exclusions           text[] not null default '{}',
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists match_intents_one_active on match_intents(participant_id) where active;

create table if not exists rendezvous (
  rendezvous_id                 text primary key,
  participant_a                 text not null references participants(participant_id),
  participant_b                 text not null references participants(participant_id),
  pair_key                      text not null,
  state                         text not null default 'OPEN' check (state in ('OPEN','CLOSED')),
  phase                         text not null default 'SCREEN' check (phase in ('SCREEN','DEEP','DECIDING','CLOSED')),
  outcome                       text check (outcome in ('MUTUAL_AFFINITY','NO_INTRODUCTION','DECLINED','WITHDRAWN','EXPIRED','BLOCKED','OPERATOR_CLOSED')),
  opened_by                     text not null,
  message_count                 int not null default 0,
  messages_from_a               int not null default 0,
  messages_from_b               int not null default 0,
  last_message_at               timestamptz,
  last_sender                   text,
  consecutive_from_last_sender  int not null default 0,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  closed_at                     timestamptz,
  closed_by                     text
);
create index if not exists rendezvous_pair_idx on rendezvous(pair_key);
create index if not exists rendezvous_a_idx on rendezvous(participant_a, state);
create index if not exists rendezvous_b_idx on rendezvous(participant_b, state);

create table if not exists messages (
  message_id             text primary key,
  rendezvous_id          text not null references rendezvous(rendezvous_id) on delete cascade,
  sender_participant_id  text not null,
  sequence               int not null,
  content_json           jsonb not null,
  created_at             timestamptz not null default now(),
  unique (rendezvous_id, sequence)
);

create table if not exists message_reads (
  rendezvous_id       text not null references rendezvous(rendezvous_id) on delete cascade,
  participant_id      text not null,
  last_read_sequence  int not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (rendezvous_id, participant_id)
);

create table if not exists recommendations (
  recommendation_id  text primary key,
  rendezvous_id      text not null references rendezvous(rendezvous_id) on delete cascade,
  participant_id     text not null,
  recommend          boolean not null,
  confidence         real,
  strengths_json     jsonb not null default '[]'::jsonb,
  concerns_json      jsonb not null default '[]'::jsonb,
  questions_json     jsonb not null default '[]'::jsonb,
  notes              text,
  submitted_at       timestamptz not null default now(),
  unique (rendezvous_id, participant_id)
);

create table if not exists counterparty_assessments (
  assessment_id    text primary key,
  rendezvous_id    text not null references rendezvous(rendezvous_id) on delete cascade,
  assessor_id      text not null,
  subject_id       text not null,
  assessment_json  jsonb not null,
  created_at       timestamptz not null default now(),
  unique (rendezvous_id, assessor_id)
);

create table if not exists blocks (
  blocker_id  text not null,
  blocked_id  text not null,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create table if not exists reports (
  report_id      text primary key,
  reporter_id    text not null,
  subject_id     text not null,
  rendezvous_id  text,
  reason         text not null,
  details        text,
  created_at     timestamptz not null default now(),
  review_state   text not null default 'open' check (review_state in ('open','reviewed','actioned','dismissed')),
  reviewed_at    timestamptz,
  review_notes   text
);
create index if not exists reports_subject_idx on reports(subject_id);
create index if not exists reports_state_idx on reports(review_state);

-- Append-only.
create table if not exists trust_events (
  event_id               bigserial primary key,
  participant_id         text not null,
  event_type             text not null,
  source_participant_id  text,
  rendezvous_id          text,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);
create index if not exists trust_events_pid_idx on trust_events(participant_id, event_type);

-- Every protocol action, success or failure. Never contains secrets.
create table if not exists audit_log (
  audit_id        bigserial primary key,
  participant_id  text,
  tool            text not null,
  ok              boolean not null,
  error_code      text,
  summary         jsonb not null default '{}'::jsonb,
  ip              text,
  created_at      timestamptz not null default now()
);
create index if not exists audit_pid_tool_idx on audit_log(participant_id, tool, created_at);

create table if not exists settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
insert into settings(key, value) values ('network_paused', 'false'::jsonb) on conflict do nothing;

-- Stripe webhook receipts (V1 monetization scaffold; Day Zero is free).
create table if not exists billing_events (
  event_id     text primary key,
  event_type   text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);
