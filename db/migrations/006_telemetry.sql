-- Funnel telemetry: cookie-less, IPs stored only as daily-salted hashes.
create table if not exists mcp_events (
  event_id         bigserial primary key,
  at               timestamptz not null default now(),
  kind             text not null,             -- initialize | tools_list
  client_name      text,
  client_version   text,
  protocol_version text,
  user_agent       text,
  ip_hash          text
);
create index if not exists mcp_events_at_idx on mcp_events(at);
create index if not exists mcp_events_kind_idx on mcp_events(kind, at);

create table if not exists web_visits (
  visit_id       bigserial primary key,
  at             timestamptz not null default now(),
  path           text not null,
  referrer_host  text,
  ua_class       text not null,               -- browser | agent | bot | unknown
  user_agent     text,
  ip_hash        text
);
create index if not exists web_visits_at_idx on web_visits(at);
create index if not exists web_visits_path_idx on web_visits(path, at);
