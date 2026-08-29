-- Membership model: free to register and watch; membership to participate. Invitations from members to non-members.
alter table participants drop constraint if exists participants_plan_status_check;
alter table participants add constraint participants_plan_status_check
  check (plan_status in ('none','active','past_due','canceled','paused','comped'));
update participants set plan = 'member' where plan = 'plus';
alter table participants add column if not exists stripe_price_id text;

alter table rendezvous add column if not exists kind text not null default 'rendezvous' check (kind in ('invitation','rendezvous'));
alter table rendezvous add column if not exists invitation_expires_at timestamptz;
create index if not exists rendezvous_invitations_idx on rendezvous(participant_b) where state = 'OPEN' and kind = 'invitation';
