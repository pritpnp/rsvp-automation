-- Adds a per-flyer anchor to zone_events so an admin's event-name override
-- applies ONLY to the flyer it was set for.
--
-- Why: the override name lived in zone_events keyed by zone alone, with nothing
-- tying it to a flyer. resolveEventName() returned any non-empty stored name, so
-- a rename (e.g. "Janmashtami") lingered onto the NEXT event uploaded to that
-- zone. With flyer_hash, scripts/automate.js (resolveEventName) keeps the stored
-- name only while its hash matches the current flyer; a replaced flyer resets the
-- name to the new flyer's OCR value.
--
-- Safe + idempotent. Run once in the Supabase SQL editor (Dashboard → SQL Editor).
-- Existing rows get flyer_hash = NULL; the first deploy after this keeps each
-- current name and back-fills its hash, so no existing override is lost.

alter table zone_events add column if not exists flyer_hash text;
