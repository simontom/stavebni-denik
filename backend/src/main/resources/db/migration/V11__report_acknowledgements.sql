-- ---------------------------------------------------------------------------
-- Acknowledgement of a signed entry by several parties (decision D3).
--
-- Until now an entry had room for ONE acknowledgement (two columns of "daily_reports"), so the first inspector or client
-- to read it closed the question for everybody. The technical supervision, the author's supervision and the client each
-- take note of an entry, and each of them has to be on record: one row per person, written once, never changed.
--
-- The two columns are dropped. That also makes a signed daily report completely immutable: the trigger of V5 let the
-- acknowledgement columns through, and no column needs that exception any more.
-- ---------------------------------------------------------------------------

CREATE TABLE "report_acknowledgements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reportId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    -- the role the person held in the project when they took note (INSPECTOR or INVESTOR)
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_acknowledgements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_acknowledgements_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "daily_reports"("id") ON DELETE RESTRICT,
    CONSTRAINT "report_acknowledgements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- once per person and entry
    CONSTRAINT "report_acknowledgements_report_user_key" UNIQUE ("reportId", "userId")
);

-- What was acknowledged under the old scheme keeps its place (the role is the person's role in the project, falling
-- back to their account role).
INSERT INTO "report_acknowledgements" ("reportId", "userId", "role", "createdAt")
SELECT r."id", r."acknowledgedById",
       COALESCE((SELECT m."role" FROM "project_members" m WHERE m."projectId" = r."projectId" AND m."userId" = r."acknowledgedById"),
                (SELECT u."role" FROM "users" u WHERE u."id" = r."acknowledgedById")),
       COALESCE(r."acknowledgedAt", r."updatedAt")
  FROM "daily_reports" r
 WHERE r."acknowledgedById" IS NOT NULL;

-- Append-only, and only for a signed entry.
CREATE OR REPLACE FUNCTION report_acknowledgements_append_only()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'an acknowledgement cannot be changed or deleted (acknowledgement %)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM "daily_reports" r
        WHERE r."id" = NEW."reportId" AND r."lockedAt" IS NOT NULL AND r."deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'only a signed daily report can be acknowledged (report %)', NEW."reportId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS report_acknowledgements_append_only ON "report_acknowledgements";
CREATE TRIGGER report_acknowledgements_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON "report_acknowledgements"
  FOR EACH ROW EXECUTE FUNCTION report_acknowledgements_append_only();

-- A signed daily report: no column may change at all any more.
DROP TRIGGER IF EXISTS daily_reports_locked_immutable ON "daily_reports";
ALTER TABLE "daily_reports" DROP COLUMN "acknowledgedAt";
ALTER TABLE "daily_reports" DROP COLUMN "acknowledgedById";

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

  IF OLD."lockedAt" IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'a signed daily report cannot be changed (report %)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER daily_reports_locked_immutable
  BEFORE UPDATE OR DELETE ON "daily_reports"
  FOR EACH ROW EXECUTE FUNCTION daily_reports_block_locked_change();
