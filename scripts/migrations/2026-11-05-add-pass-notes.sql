-- A private note on each VIP pass, e.g. "From Allentown" or "Dr. Shah's
-- parents", to tell apart guests with the same name.
--
-- Shown in the admin portal (create, edit, the pass list and the spreadsheet
-- upload's Note column), to volunteers on the /scan result, in the
-- "<name> has arrived" Telegram messages and in the bot's /vips list.
-- Never on the guest's own pass or its link preview.
--
-- Empty string = no note. Idempotent: safe to paste more than once.

alter table vip_passes
  add column if not exists note text not null default '';
