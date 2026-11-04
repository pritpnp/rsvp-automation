-- Adds a per-event VIP parking location, shown on every VIP pass for the event
-- with Apple Maps / Google Maps directions. Set in the admin portal when
-- creating or editing an event.
--   vip_parking       an address, or "lat, lng" coordinates
--   vip_parking_note  optional one-line direction, e.g. "Enter from the back gate"
-- Empty string = no parking panel on the pass.
-- Idempotent: safe to paste more than once.

alter table events
  add column if not exists vip_parking text not null default '',
  add column if not exists vip_parking_note text not null default '';
