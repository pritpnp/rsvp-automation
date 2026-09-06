-- Adds a horizontal flip/mirror flag to the per-photo landscape crop.
-- Idempotent: safe to paste more than once.

alter table photo_og_crops
  add column if not exists flip_x boolean not null default false;
