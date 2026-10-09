-- ---------------------------------------------------------------------------
-- A signature covers the content of the entry, and says so.
--
-- "daily_reports"."signatureHash" is the SHA-256 of the canonical content of a daily report at the moment it was signed
-- (text fields, the workers list, the weather, who signed and when, and the hashes of the photos). It is written in the
-- same statement that locks the entry, so it can never be changed afterwards (the signed-records triggers of V5 freeze
-- every column of a locked row). The content can be hashed again at any time and compared: that detects a change made
-- behind the application's back, which the audit log alone would only show if the chain itself were also rewritten.
--
-- The photos get the hashes of their two stored files at upload. Rows that exist already keep NULL (test data only:
-- no release has happened yet).
-- ---------------------------------------------------------------------------

ALTER TABLE "daily_reports" ADD COLUMN "signatureHash" TEXT;

ALTER TABLE "photos" ADD COLUMN "sha256" TEXT;
ALTER TABLE "photos" ADD COLUMN "thumbSha256" TEXT;
