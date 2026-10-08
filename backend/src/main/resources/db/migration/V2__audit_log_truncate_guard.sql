-- ---------------------------------------------------------------------------
-- audit_log: block TRUNCATE
--
-- V1 blocks UPDATE and DELETE of single rows (trigger), but TRUNCATE is a
-- different statement: it fires no row triggers and would wipe the whole log in
-- one go, after which the hash chain verifies as "ok" (an empty chain is
-- valid). This statement-level trigger refuses it. Like the V1 triggers it is a
-- guard against mistakes and against an application that holds only ordinary
-- privileges; whoever owns the table can still disable it, which is why the
-- latest chain hash is also kept outside the database (see PROJECT.md, "Audit
-- log") and checked by `AdminCliKt audit-verify`.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_block_truncate()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log rows are append-only (operation: %); it cannot be truncated.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON "audit_log";
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_truncate();

-- Same as V1: only when a dedicated `app` role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    EXECUTE 'REVOKE TRUNCATE ON "audit_log" FROM app';
  END IF;
END;
$$;
