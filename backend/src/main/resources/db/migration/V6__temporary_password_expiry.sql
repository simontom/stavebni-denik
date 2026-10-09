-- ---------------------------------------------------------------------------
-- A temporary password does not stay valid forever.
--
-- An account made by an administrator, and an account whose password an
-- administrator reset, has a generated password that is handed over once (on
-- paper, in a message). If it is never used it must stop working: "passwordExpiresAt"
-- is when it does. NULL means a password the user chose, which does not expire.
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN "passwordExpiresAt" TIMESTAMPTZ;

-- Temporary passwords that exist when this migration runs get a week from now.
UPDATE "users"
   SET "passwordExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '7 days'
 WHERE "mustChangePwd" AND "deletedAt" IS NULL;
