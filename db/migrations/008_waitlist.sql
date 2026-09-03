-- Be-found waitlist: people who would rather be found than search, before the matchmaker opens in their region.
-- Email is stored in clear because it is the only way to reach them; it is never shown to anyone and deleted on request.
create table if not exists waitlist (
  waitlist_id        text primary key,
  email              text not null,
  email_norm         text not null unique,
  first_name         text,
  region             text not null,
  region_normalized  text not null,
  gender             text not null,
  seeking            text[] not null,
  age_band           text not null,
  source             text,
  ip_hash            text,
  user_agent         text,
  status             text not null default 'waiting' check (status in ('waiting','invited','joined','removed')),
  created_at         timestamptz not null default now(),
  notified_at        timestamptz
);
create index if not exists waitlist_region_idx on waitlist(region_normalized) where status = 'waiting';
create index if not exists waitlist_ip_idx on waitlist(ip_hash, created_at);
