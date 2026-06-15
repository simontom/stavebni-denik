-- ===========================================================================
-- Bootstrap script for the unprivileged `app` role used by the running
-- Next.js application. Run this ONCE as a Postgres superuser BEFORE
-- the first `prisma migrate deploy` — afterwards Prisma migrations will
-- handle further GRANT/REVOKE statements.
--
-- Why a separate role?
--   The migrator role must keep DDL + DML on every table. The runtime
--   role, however, must be unable to UPDATE/DELETE rows in `audit_log`.
--   Splitting the two enforces that property at the Postgres level —
--   any future bug or compromised app secret cannot tamper with the
--   audit chain.
--
-- Production setup outline (Fly Postgres):
--   1. Connect as the postgres superuser.
--   2. Edit the password placeholder below.
--   3. Run this file.
--   4. Set DATABASE_URL on the app to use `app:<password>@host/db`.
--   5. Deploy — Prisma migrations are run with the same connection
--      because the `app` role still has CREATE on the schema.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    EXECUTE format('CREATE ROLE app LOGIN PASSWORD %L', current_setting('app.password', true));
  END IF;
END;
$$;

-- Default privileges on tables created later by migrations.
GRANT CONNECT ON DATABASE CURRENT_DATABASE() TO app;
GRANT USAGE, CREATE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;

-- If audit_log already exists, lock it down right away.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'audit_log') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "audit_log" FROM app';
  END IF;
END;
$$;
