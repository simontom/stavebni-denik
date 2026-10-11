-- ===========================================================================
-- Creates the role the RUNNING application connects as (decision D5).
--
-- Run ONCE per database, as a PostgreSQL superuser or the database owner, before the first `migrate`:
--
--     psql -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" -d stavebni_denik -f scripts/sql/bootstrap-app-role.sql
--
-- Then, with the OWNER's credentials (never the application's):
--
--     DB_MIGRATE_USER=<owner> DB_MIGRATE_PASSWORD=<...> DB_APP_ROLE=app JDBC_URL=<...> \
--       java -cp backend-all.jar cz.stavebni.denik.cli.AdminCliKt migrate
--
-- `migrate` creates and updates the schema as the owner, then gives this role data access and nothing more
-- (db/grants/app-role.sql): it cannot create or drop a table, switch a trigger off, truncate anything, or change the audit
-- log. The application is configured with JDBC_URL, DB_USER=app and DB_PASSWORD; it never holds the owner's password and,
-- in production, never migrates (it refuses to start when the schema is not current).
--
-- Why: a role that owns the tables can disable the triggers that make the audit chain, the signed records and the
-- append-only tables tamper-resistant, so anybody who stole the application's password could rewrite history. With this
-- split those protections bind the application's own role.
-- ===========================================================================

-- The role: can log in and connect, owns nothing, cannot create roles or databases.
SELECT format('CREATE ROLE app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')
\gexec

-- A role that already exists gets the new password (running the script again rotates it).
SELECT format('ALTER ROLE app PASSWORD %L', :'app_password')
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO app', current_database())
\gexec
