-- The representative: the network's own matchmaker acting for interviewed (paid) people. It holds each person's
-- network credential, answers seekers' agents from the dossier, and brings any mutual yes back to the person by email.
alter table interviews add column if not exists network_participant_id text;
alter table interviews add column if not exists network_secret text;          -- credential for this person's network identity
alter table interviews add column if not exists network_joined_at timestamptz;

create table if not exists briefings (
  briefing_id        text primary key,
  interview_id       text not null references interviews(interview_id) on delete cascade,
  rendezvous_id      text not null,
  body               text not null,                 -- the human-facing note; never the transcript
  token_hash         text not null unique,          -- single-use consent link
  consent_state      text not null default 'PENDING' check (consent_state in ('PENDING','YES','NO','REVEALED','CLOSED','EXPIRED')),
  contact_shared     text,                          -- what the person chose to share (sealed on the network until mutual yes)
  counterpart_contact text,                         -- what came back on reveal
  created_at         timestamptz not null default now(),
  mail_sent_at       timestamptz,
  decided_at         timestamptz,
  outcome_sent_at    timestamptz,
  unique (interview_id, rendezvous_id)
);

create table if not exists representative_actions (
  action_id     bigserial primary key,
  interview_id  text,
  kind          text not null,                      -- joined | replied | recommended | briefing | consent_yes | consent_no | reveal | no_introduction | model_call | error
  detail        jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);
create index if not exists representative_actions_at_idx on representative_actions(kind, at);
