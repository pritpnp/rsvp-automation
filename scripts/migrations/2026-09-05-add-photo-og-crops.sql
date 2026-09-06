-- Per-photo LANDSCAPE (preview/OG card) crop overrides.
--
-- Why this exists: each photo's `photo` crop in swami-photos.json is tuned for
-- the flyer's tall portrait box. The landscape card's panel is a different shape
-- AND feathers away its right ~22%, so a subject centred for the flyer lands
-- right of the landscape card's visible centre. These rows are optional
-- per-photo overrides; a photo with no row falls back to its flyer crop.
--
-- photo_id is the id from public/flyer-builder/swami-photos.json (a
-- filename-derived slug such as '030'). Rows for photos that no longer exist in
-- the manifest are simply ignored by the builder, which merges by id.
--
-- Columns are snake_case (Postgres folds unquoted identifiers to lower case);
-- the API maps them to the camelCase focusX/focusY/zoom the renderer expects.
--
-- Idempotent: safe to paste into the Supabase SQL editor more than once.

create table if not exists photo_og_crops (
  photo_id   text primary key,
  focus_x    real        not null default 0.5,
  focus_y    real        not null default 0.5,
  zoom       real        not null default 1.0,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table photo_og_crops is
  'Per-photo crop overrides for the landscape preview/OG card. No row = use the flyer crop.';
