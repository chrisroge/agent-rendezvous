-- RAP/0.3: human consent and contact reveal after mutual affinity.
-- Contact channels are supplied at consent time only, held sealed, revealed only on mutual YES,
-- and deleted immediately on decline or expiry.
create table if not exists introductions (
  rendezvous_id  text primary key references rendezvous(rendezvous_id) on delete cascade,
  state          text not null default 'AWAITING_BOTH' check (state in ('AWAITING_BOTH','REVEALED','DECLINED','EXPIRED')),
  a_consent      text not null default 'PENDING' check (a_consent in ('PENDING','YES','NO')),
  b_consent      text not null default 'PENDING' check (b_consent in ('PENDING','YES','NO')),
  a_contact      text,
  b_contact      text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  revealed_at    timestamptz,
  closed_at      timestamptz
);
