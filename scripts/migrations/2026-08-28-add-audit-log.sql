-- Audit log: who / what / when for manager logins and every state-changing
-- manager action. Written fire-and-forget by netlify/functions/_audit.js and
-- read (superadmin-only) by netlify/functions/superadmin-audit-log.js.
--
-- Safe + idempotent. Run once in the Supabase SQL editor (Dashboard -> SQL Editor).

create table if not exists audit_log (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  actor_id      text,                      -- managers.id as text; null for superadmin/unknown
  actor_name    text not null default 'unknown',  -- 'admin' (superadmin) or the manager username
  is_superadmin boolean not null default false,
  action        text not null,             -- e.g. 'login', 'flyer.upload', 'rsvp.delete'
  target        text,                      -- object acted on (zone, id, username, ...)
  details       jsonb,                     -- extra structured context
  success       boolean not null default true,
  ip            text,
  user_agent    text
);

create index if not exists audit_log_created_at_idx on audit_log (created_at desc);

-- Match the rest of the schema: RLS on, no policies, so ONLY the service-role key
-- (used by the Netlify functions) can read or write it. No anon/public access.
alter table audit_log enable row level security;
