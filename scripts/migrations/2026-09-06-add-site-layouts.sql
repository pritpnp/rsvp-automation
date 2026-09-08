-- Live flyer layout overrides, saved from the builder's Advanced panel.
--
-- site_layouts holds ONE current row per key (today only 'flyer'). `layout` is
-- the same object the builder's "Save layout" used to download as
-- flyer-layout.json (header, footer, photoBox, fade, satsang, text, og). The
-- builder loads it on top of the static flyer-layout.json, so a save takes
-- effect on the next load with no commit or redeploy.
--
-- Saving is a FULL-SNAPSHOT REPLACE, so every save first copies the outgoing
-- value into site_layout_history. That is the undo trail: there is no other
-- record of a previous layout once it is overwritten.
--
-- Idempotent: safe to paste into the Supabase SQL editor more than once.

create table if not exists site_layouts (
  key        text primary key,
  layout     jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table site_layouts is
  'Live layout overrides for the flyer builder (key = ''flyer''). Loaded over the static flyer-layout.json.';

create table if not exists site_layout_history (
  id       bigserial   primary key,
  key      text        not null,
  layout   jsonb       not null,
  saved_at timestamptz not null default now(),
  saved_by text
);

create index if not exists site_layout_history_key_saved_at_idx
  on site_layout_history (key, saved_at desc);

comment on table site_layout_history is
  'Append-only previous versions of site_layouts, written before each overwrite so a bad save can be rolled back.';
