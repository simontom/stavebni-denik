-- ---------------------------------------------------------------------------
-- What the vyhláška asks a daily entry to say besides the day's work (vyhláška 131/2024 Sb., příloha 12, part B).
--
-- The columns for the deliveries and storage of material, the machinery, the tests and checks, the safety notes, the
-- defects and the other notes were created with V1 but nothing wrote them (the API only returned the "other notes" as
-- `generalNotes`, which this change replaces by `details`). Two are added: the measures against dust and the measures
-- that keep the site and its surroundings accessible. All are plain text and optional.
--
-- "signatureFormat" says which fields the signature of a signed entry covers (ReportSignature):
--   1  the entry as it was before this migration (text, workers, weather, ... but not the fields above);
--   2  the entry including these fields.
-- Entries signed before this migration keep format 1 so their signatures still verify; the column is filled by its default,
-- which touches no row (a signed entry cannot be updated, V5).
--
-- The default stays 1 on purpose: the format is a property of the SIGNATURE, set by the application at the moment it signs
-- (lockReport), not of the row. A writer that does not know the column (the previous version of the application, which
-- keeps serving between `migrate` and the deploy; a fixture) signs in format 1, and the row must say so. With a default of
-- 2 such an entry would be marked as covering fields its hash never covered, and could never be repaired (V5).
-- ---------------------------------------------------------------------------

ALTER TABLE "daily_reports"
    ADD COLUMN "dustMeasures" TEXT,
    ADD COLUMN "accessibilityMeasures" TEXT,
    ADD COLUMN "signatureFormat" SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE "daily_reports"
    ADD CONSTRAINT "daily_reports_signature_format_check" CHECK ("signatureFormat" IN (1, 2));
