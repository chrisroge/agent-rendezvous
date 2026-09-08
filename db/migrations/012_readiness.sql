alter table interviews add column if not exists last_cycle_at timestamptz;
create index if not exists interviews_cycle_idx on interviews(last_cycle_at) where status = 'paid';
-- Capture is only enabled in explicitly isolated staging. Never contains real mail.
create table if not exists captured_mail (
 mail_id bigserial primary key, kind text not null, recipient text not null,
 subject text not null, body text not null, created_at timestamptz not null default now()
);
