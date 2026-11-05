-- Volunteers and VIP arrival check-in.
--
-- Volunteers sign in at screvents.com/scan, scan a guest's VIP pass QR code and
-- tap Check In. The first check-in of a pass records when and by whom, and
-- posts "VIP <name> has arrived" to the admin Telegram group.
--
--   volunteers           accounts the superadmin adds in the admin portal
--                        (Volunteers tab). Separate from managers: a volunteer
--                        can only look up and check in passes.
--   volunteer_sessions   sign-in tokens for /scan. Deliberately NOT stored in
--                        manager_sessions, where manager_id = null means
--                        superadmin. Removing a volunteer deletes their
--                        sessions (on delete cascade), signing them out.
--   vip_passes.checked_in_at / checked_in_by
--                        first arrival only; a second scan (another car)
--                        leaves them as they are.
--
-- Safe + idempotent. Run once in the Supabase SQL editor (Dashboard -> SQL Editor).

create table if not exists volunteers (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists volunteer_sessions (
  token         text primary key,
  volunteer_id  uuid not null references volunteers(id) on delete cascade,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create index if not exists volunteer_sessions_volunteer_id_idx on volunteer_sessions (volunteer_id);

alter table vip_passes
  add column if not exists checked_in_at timestamptz,
  add column if not exists checked_in_by text;

-- The arrivals list in the Telegram message reads this per event.
create index if not exists vip_passes_event_checked_in_idx on vip_passes (event_id, checked_in_at);

-- Match the rest of the schema: RLS on, no policies, so ONLY the service-role key
-- (used by the Netlify functions) can read or write them. No anon/public access.
alter table volunteers         enable row level security;
alter table volunteer_sessions enable row level security;
