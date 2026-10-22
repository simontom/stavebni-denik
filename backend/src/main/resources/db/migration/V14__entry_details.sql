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
--   2  the entry including these fields;
--   3  the entry including the start, interruption and resumption of work ("workStateChanges"), the weather as its text,
--      and, frozen at the moment of signing, the signer's name and ČKAIT number ("signerName", "signerCkaitNumber") and
--      the identification of the diary ("partASnapshot"), see V1 and ReportSignature.
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
    ADD CONSTRAINT "daily_reports_signature_format_check" CHECK ("signatureFormat" IN (1, 2, 3));

-- Format 3 is a signature that stored who signed and what part A said, and only such a signature is in format 3: an entry is
-- in format 3 if and only if it is signed (locked) and carries a signer name, a ČKAIT number and a snapshot, so a signature
-- that lacks one of them cannot be stored, and a format 1 or 2 entry has none of the three (they were never covered).
-- The application sets all of it in the one statement that signs; V5 and V11 freeze every column afterwards.
ALTER TABLE "daily_reports"
    ADD CONSTRAINT "daily_reports_signature_format_3_check" CHECK (
        CASE WHEN "signatureFormat" = 3
             THEN "lockedAt" IS NOT NULL
              AND btrim(coalesce("signerName", '')) <> ''
              AND btrim(coalesce("signerCkaitNumber", '')) <> ''
              AND btrim(coalesce("partASnapshot", '')) <> ''
             ELSE "signerName" IS NULL AND "signerCkaitNumber" IS NULL AND "partASnapshot" IS NULL
        END
    );
