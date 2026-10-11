-- ---------------------------------------------------------------------------
-- Entries by other parties ("remarks"): append-only, and for people outside the site team too.
--
-- The technical supervision, the author's supervision, the client and the authorities make their own entries in the
-- diary, also after the day's entry was signed. Such an entry is a new record that can never be changed or deleted
-- afterwards (the same append-only rule as for addenda, V9). An authority or a person without an account does not write
-- it themselves: the project's manager records it on their behalf and names them in "externalAuthor" (decision D9),
-- with the type EXTERNAL_ENTRY.
-- ---------------------------------------------------------------------------

ALTER TYPE "RemarkType" ADD VALUE IF NOT EXISTS 'EXTERNAL_ENTRY';

ALTER TABLE "remarks" ADD COLUMN "externalAuthor" TEXT;

CREATE OR REPLACE FUNCTION remarks_append_only()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'an entry of another party cannot be changed or deleted (entry %)', OLD."id" USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS remarks_append_only ON "remarks";
CREATE TRIGGER remarks_append_only
  BEFORE UPDATE OR DELETE ON "remarks"
  FOR EACH ROW EXECUTE FUNCTION remarks_append_only();
