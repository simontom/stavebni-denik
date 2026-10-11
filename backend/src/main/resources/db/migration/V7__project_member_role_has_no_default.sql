-- ---------------------------------------------------------------------------
-- A project member's role has no default.
--
-- What a person may do in a project follows the role they hold in it
-- ("project_members"."role"). V1 gave that column the default 'BOSS', so a row
-- inserted without a role (a forgotten column, a script) made its person a
-- project manager with the right to sign the diary. Every insert in the
-- application names the role; from now on the database insists on it too.
-- Existing rows keep the role they have.
-- ---------------------------------------------------------------------------

ALTER TABLE "project_members" ALTER COLUMN "role" DROP DEFAULT;
