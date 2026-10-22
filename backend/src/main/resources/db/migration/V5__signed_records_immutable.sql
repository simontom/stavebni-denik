-- ---------------------------------------------------------------------------
-- Signed records are immutable in the database too
--
-- The application refuses to change a signed daily report, to add photos to it, or
-- to change a signed handover protocol, and it takes its decisions on rows locked
-- FOR UPDATE. These triggers are the last line: whatever code path or manual SQL
-- tries it, the database refuses. They compare the whole row (as jsonb), so a
-- column added later is protected without touching this file.
--
-- Like the audit-log triggers they stop mistakes and an application with ordinary
-- privileges; whoever owns the tables can disable them.
-- ---------------------------------------------------------------------------

-- A signed (locked) daily report: only the acknowledgement may still be added.
CREATE OR REPLACE FUNCTION daily_reports_block_locked_change()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."lockedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'a signed daily report cannot be deleted (report %)', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."lockedAt" IS NOT NULL
     AND (to_jsonb(NEW) - 'acknowledgedAt' - 'acknowledgedById')
         IS DISTINCT FROM (to_jsonb(OLD) - 'acknowledgedAt' - 'acknowledgedById') THEN
    RAISE EXCEPTION 'a signed daily report cannot be changed (report %)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS daily_reports_locked_immutable ON "daily_reports";
CREATE TRIGGER daily_reports_locked_immutable
  BEFORE UPDATE OR DELETE ON "daily_reports"
  FOR EACH ROW EXECUTE FUNCTION daily_reports_block_locked_change();

-- Photos of a signed report cannot be added, changed or removed.
CREATE OR REPLACE FUNCTION photos_block_locked_report()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
       SELECT 1 FROM "daily_reports" r WHERE r."id" = OLD."reportId" AND r."lockedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'photos of a signed daily report cannot be changed (report %)', OLD."reportId" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND EXISTS (
       SELECT 1 FROM "daily_reports" r WHERE r."id" = NEW."reportId" AND r."lockedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'a photo cannot be added to a signed daily report (report %)', NEW."reportId" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS photos_locked_report ON "photos";
CREATE TRIGGER photos_locked_report
  BEFORE INSERT OR UPDATE OR DELETE ON "photos"
  FOR EACH ROW EXECUTE FUNCTION photos_block_locked_report();

-- A handover protocol that a party has signed cannot be changed or deleted (backlog A3). A protocol is an act of two parties, each
-- signs once (the table "site_handover_signatures", V1), and the content is frozen from the FIRST signature on, so that the second
-- party signs what the first one signed. The signature itself is written once.
CREATE OR REPLACE FUNCTION site_handovers_block_signed_change()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "site_handover_signatures" s WHERE s."handoverId" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a handover protocol that a party has signed cannot be deleted (protocol %)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'a handover protocol that a party has signed cannot be changed (protocol %)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS site_handovers_signed_immutable ON "site_handovers";
CREATE TRIGGER site_handovers_signed_immutable
  BEFORE UPDATE OR DELETE ON "site_handovers"
  FOR EACH ROW EXECUTE FUNCTION site_handovers_block_signed_change();

-- A signature of a handover protocol is append-only, and only a protocol that has not been deleted can be signed.
CREATE OR REPLACE FUNCTION site_handover_signatures_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'a signature of a handover protocol cannot be changed or deleted (signature %)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "site_handovers" h WHERE h."id" = NEW."handoverId" AND h."deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'only a handover protocol that has not been deleted can be signed (protocol %)', NEW."handoverId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS site_handover_signatures_guard ON "site_handover_signatures";
CREATE TRIGGER site_handover_signatures_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "site_handover_signatures"
  FOR EACH ROW EXECUTE FUNCTION site_handover_signatures_guard();
