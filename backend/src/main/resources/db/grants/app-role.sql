-- ---------------------------------------------------------------------------
-- What the running application's database role may do (decision D5).
--
-- Applied by `migrate` after the schema is migrated, with the owner's credentials; safe to run again (it is run every
-- time). The placeholder ${role} is replaced by a validated, quoted role name: nothing else is substituted.
--
-- The application's role OWNS nothing. It cannot create or drop a table, disable a trigger (that needs ownership),
-- truncate anything, or change the audit log. The triggers and rules the migrations put in (the audit chain, signed
-- records, append-only tables) therefore bind it, and bind whoever steals its password.
-- ---------------------------------------------------------------------------

-- No DDL in the schema: usage only.
REVOKE ALL ON SCHEMA public FROM ${role};
GRANT USAGE ON SCHEMA public TO ${role};

-- Ordinary data access to every table. No TRUNCATE, no TRIGGER, no REFERENCES.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};

-- The audit log: append and read, never change or remove (the triggers refuse it too; this is the second wall).
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM ${role};

-- The schema history: read only, so that the application can check the schema is current.
REVOKE ALL ON "flyway_schema_history" FROM ${role};
GRANT SELECT ON "flyway_schema_history" TO ${role};

-- Tables and sequences that later migrations create (by the role that runs this script) get the same data access.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role};
