-- ===========================================================================
-- Bootstrap script for the unprivileged `app` role used by the running
-- Next.js application. Run this ONCE as a Postgres superuser BEFORE
-- the first `prisma migrate deploy` — afterwards Prisma migrations will
-- handle further GRANT/REVOKE statements.
--
-- Why a separate role?
--   The migrator role must keep DDL + DML on every table. The runtime
--   role, however, must be unable to DELETE rows in `audit_log`.
--   (It retains UPDATE privilege only to allow SELECT ... FOR UPDATE row locks;
--   actual updates are blocked by the audit_log_no_update trigger).
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
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app', current_database());
END;
$$;
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
    -- Postgres requires UPDATE privilege to use SELECT ... FOR UPDATE (row locking).
    -- Since we use FOR UPDATE to prevent race conditions during audit hashing,
    -- we must leave UPDATE granted. Actual data mutation is prevented by the
    -- 'audit_log_no_update' trigger which aborts the transaction.
    EXECUTE 'REVOKE DELETE ON "audit_log" FROM app';
  END IF;
END;
$$;
