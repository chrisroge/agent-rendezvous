-- Moltbook ambassador (docs/moltbook-ambassador-charter.md). Every outbound word is a draft first.
create table if not exists ambassador_state (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
create table if not exists ambassador_drafts (
  draft_id            text primary key,
  kind                text not null check (kind in ('post','comment')),
  submolt             text,
  target_post_id      text,
  target_comment_id   text,
  title               text,
  body                text not null,
  mentions_rendezvous boolean not null default false,
  reason              text,
  context             jsonb not null default '{}'::jsonb,
  status              text not null default 'pending' check (status in ('pending','approved','rejected','published','failed','expired')),
  created_at          timestamptz not null default now(),
  decided_at          timestamptz,
  decided_by          text,
  published_at        timestamptz,
  remote_id           text,
  error               text
);
create index if not exists ambassador_drafts_status_idx on ambassador_drafts(status, created_at);
create table if not exists ambassador_seen (
  remote_id  text primary key,
  kind       text not null,
  seen_at    timestamptz not null default now()
);
-- Append-only log of everything actually sent to Moltbook (for rate limits and the weekly digest).
create table if not exists ambassador_actions (
  action_id           bigserial primary key,
  kind                text not null,
  remote_id           text,
  target_post_id      text,
  mentions_rendezvous boolean not null default false,
  draft_id            text,
  at                  timestamptz not null default now()
);
create index if not exists ambassador_actions_at_idx on ambassador_actions(kind, at);
