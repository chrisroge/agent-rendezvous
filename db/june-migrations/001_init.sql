-- June: the hosted matchmaker. Her own database; she reaches the Rendezvous network only through the public MCP API.
create table if not exists clients (
  client_id         text primary key,
  resume_code_hash  text not null unique,
  email             text,
  first_name        text,
  status            text not null default 'interviewing' check (status in ('interviewing','searching','paused','closed')),
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);
create table if not exists conversations (
  client_id   text not null references clients(client_id) on delete cascade,
  seq         int not null,
  role        text not null check (role in ('client','june')),
  content     text not null,
  created_at  timestamptz not null default now(),
  primary key (client_id, seq)
);
create table if not exists dossiers (
  client_id          text primary key references clients(client_id) on delete cascade,
  dossier_json       jsonb not null default '{}'::jsonb,   -- facts with EXPLICIT/OBSERVED/INFERRED provenance
  intent_json        jsonb,                                 -- coarse network intent once complete
  share_permissions  jsonb not null default '{}'::jsonb,
  interview_complete boolean not null default false,
  network_participant_id text,
  network_secret     text,                                  -- June's credential for this client's network identity
  updated_at         timestamptz not null default now()
);
create table if not exists briefings (
  briefing_id   text primary key,
  client_id     text not null references clients(client_id) on delete cascade,
  rendezvous_id text not null,
  kind          text not null check (kind in ('affinity','update')),
  body          text not null,
  consent_token_hash text,
  consent_state text not null default 'PENDING' check (consent_state in ('PENDING','YES','NO','EXPIRED')),
  contact_shared text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create table if not exists june_actions (
  action_id   bigserial primary key,
  client_id   text,
  kind        text not null,
  detail      jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
