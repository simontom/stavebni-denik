-- ---------------------------------------------------------------------------
-- Late entries (decision D10)
--
-- An entry for today, or for any day since the previous working day, is normal.
-- An entry for an earlier day is allowed only as a *late entry*: it is flagged
-- and carries the reason the author gave. The application enforces the date
-- window; this migration stores the flag and the reason and makes sure a flagged
-- entry never has a blank reason.
-- ---------------------------------------------------------------------------

ALTER TABLE "daily_reports"
  ADD COLUMN "isLateEntry" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lateEntryReason" TEXT;

ALTER TABLE "daily_reports"
  ADD CONSTRAINT "daily_reports_late_entry_reason_chk"
  CHECK (NOT "isLateEntry" OR btrim(coalesce("lateEntryReason", '')) <> '');
