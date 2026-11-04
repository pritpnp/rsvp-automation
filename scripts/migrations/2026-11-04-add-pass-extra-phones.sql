-- Lets one VIP pass carry several phone numbers (e.g. a husband and wife, when
-- it is not known which will come). The first number stays in phone /
-- phone_normalized exactly as before; any others are stored here as 10-digit
-- strings. Guests can look the pass up with any of them, and no number may
-- appear on two passes for the same event (checked in admin-passes.js).
-- Idempotent: safe to paste more than once.

alter table vip_passes
  add column if not exists extra_phones text[] not null default '{}';

-- Lets the lookup find a pass by an extra number without scanning the table.
create index if not exists vip_passes_extra_phones_idx on vip_passes using gin (extra_phones);
