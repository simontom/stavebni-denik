-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing BOSS users keep their app-admin powers (they
-- were the only role that could manage users + read audit log
-- before this split). Bare-stavbyvedoucí accounts created AFTER
-- this migration default to isAdmin=false and need to be flipped
-- explicitly in /admin/users.
UPDATE "users" SET "isAdmin" = true WHERE "role" = 'BOSS';
