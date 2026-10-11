-- ---------------------------------------------------------------------------
-- Addenda: the way a signed daily entry is corrected or completed.
--
-- A signed entry cannot be changed (V5), so a mistake or a missing remark is put into an addendum (dodatek) that stands
-- next to it. The table is append-only and only for signed entries: an addendum cannot be changed or deleted by anyone,
-- and none can be added to an entry that is still being written (there the text is simply edited).
--
-- Like the other triggers these stop mistakes and an application with ordinary privileges; whoever owns the table can
-- switch them off. The audit log (hash chain) and the application's own checks stand beside them.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION addenda_append_only()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'an addendum cannot be changed or deleted (addendum %)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM "daily_reports" r
        WHERE r."id" = NEW."reportId" AND r."lockedAt" IS NOT NULL AND r."deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'an addendum can only be added to a signed daily report (report %)', NEW."reportId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS addenda_append_only ON "addenda";
CREATE TRIGGER addenda_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON "addenda"
  FOR EACH ROW EXECUTE FUNCTION addenda_append_only();
