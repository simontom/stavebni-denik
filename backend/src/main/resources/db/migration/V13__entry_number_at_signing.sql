-- ---------------------------------------------------------------------------
-- The number of an entry is assigned when it is signed (decision D11).
--
-- Until now an entry got its number when it was created, so a draft that was never signed (and was deleted) left a hole in
-- the sequence of the diary. The pages of a construction diary are numbered one after another without gaps, so the number
-- is now given at the moment of signing: the Nth signed entry of a project has the number N, whatever drafts came and went.
--
--   - the column may be empty (a draft has no number yet);
--   - a signed entry must have one;
--   - the number given at signing must be the next one of the project, which the database checks as well as the
--     application (the application assigns it under the audit lock, so two signatures cannot take the same number; the
--     unique index of V1 is the last line).
--
-- Entries signed before this migration keep the number they were signed with: it is part of what the signature covers.
-- Like the other triggers this one stops mistakes and an application with ordinary privileges; whoever owns the table can
-- switch it off.
-- ---------------------------------------------------------------------------

ALTER TABLE "daily_reports" ALTER COLUMN "sequenceNumber" DROP NOT NULL;

-- A draft has no number: it is given at signing.
UPDATE "daily_reports" SET "sequenceNumber" = NULL WHERE "lockedAt" IS NULL;

ALTER TABLE "daily_reports"
    ADD CONSTRAINT "daily_reports_signed_has_number" CHECK ("lockedAt" IS NULL OR "sequenceNumber" IS NOT NULL);

CREATE OR REPLACE FUNCTION daily_reports_number_at_signing()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_number INTEGER;
BEGIN
  IF OLD."lockedAt" IS NULL AND NEW."lockedAt" IS NOT NULL THEN
    SELECT COALESCE(MAX("sequenceNumber"), 0) + 1 INTO next_number
      FROM "daily_reports" WHERE "projectId" = NEW."projectId";
    IF NEW."sequenceNumber" IS DISTINCT FROM next_number THEN
      RAISE EXCEPTION 'the number of an entry given at signing must be the next one of the project (%), not % (report %)',
        next_number, NEW."sequenceNumber", NEW."id" USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD."lockedAt" IS NULL AND NEW."sequenceNumber" IS NOT NULL THEN
    RAISE EXCEPTION 'an entry that is not signed has no number yet (report %)', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS daily_reports_number_at_signing ON "daily_reports";
CREATE TRIGGER daily_reports_number_at_signing
  BEFORE UPDATE ON "daily_reports"
  FOR EACH ROW EXECUTE FUNCTION daily_reports_number_at_signing();
