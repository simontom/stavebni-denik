-- ---------------------------------------------------------------------------
-- The identification of the diary (vyhláška 131/2024 Sb., příloha 12, part A) was incomplete: the date of the permit, the
-- subcontractors and the references to the documents of the construction had no place. All three are optional text.
--
--   permitDate           the date of the permit (stavební povolení, ohlášení, ...); the number is permitNumber since V1
--   subcontractors       the firms of the subcontractors, one per line
--   supportingDocuments  the documents the diary refers to (contracts, permits, consents, decisions, protocols), one per line
--
-- Like the other dates of a project, permitDate is a point in time at midnight UTC (see Dates.parseOrNull).
-- ---------------------------------------------------------------------------

ALTER TABLE "projects"
    ADD COLUMN "permitDate" TIMESTAMPTZ,
    ADD COLUMN "subcontractors" TEXT,
    ADD COLUMN "supportingDocuments" TEXT;
