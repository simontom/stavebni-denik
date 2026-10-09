-- ---------------------------------------------------------------------------
-- Where a request came from, kept apart from the evidence (decision D7).
--
-- The IP address and the user agent are personal data. They are NOT part of the audit hash (the chain is permanent and
-- cannot be pruned), so they live in side tables that are kept for twelve months and then deleted:
--
--   audit_request_context  the address and user agent of the request that caused an audit row (one row per audit row)
--   access_log             sign-ins, failed sign-ins and sign-outs; not part of the legal chain, a record for security
--                          investigations
--
-- Both are append-only for a year: a row cannot be changed, and cannot be deleted until it is older than twelve months,
-- so that someone holding the application's credentials cannot erase the traces of what they did. The pruning command
-- (AdminCliKt prune-access-records) deletes what is older. Like the other triggers these stop an application with
-- ordinary privileges; whoever owns the table can switch them off.
-- ---------------------------------------------------------------------------

-- No foreign key to audit_log, deliberately: the side row is written in the same transaction as its audit row, so it
-- cannot dangle, and a foreign key would make TRUNCATE of audit_log fail for a second, accidental reason, which would
-- hide whether the guard trigger of V2 is the thing that stops it.
CREATE TABLE "audit_request_context" (
    "audit_id"    BIGINT       NOT NULL,
    "ip"          VARCHAR(64),
    "user_agent"  VARCHAR(256),
    "recorded_at" TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_request_context_pkey" PRIMARY KEY ("audit_id")
);

CREATE INDEX "audit_request_context_recorded_at_idx" ON "audit_request_context"("recorded_at");

CREATE TABLE "access_log" (
    "id"          BIGSERIAL    NOT NULL,
    "recorded_at" TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event"       TEXT         NOT NULL,
    -- The account, when there is one. A failed attempt against an unknown name records no name at all: what was typed
    -- into the name field may be a password.
    "user_id"     UUID,
    "ip"          VARCHAR(64),
    "user_agent"  VARCHAR(256),

    CONSTRAINT "access_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "access_log_event_check" CHECK ("event" IN ('login.success', 'login.failure', 'logout'))
);

CREATE INDEX "access_log_recorded_at_idx" ON "access_log"("recorded_at");
CREATE INDEX "access_log_user_id_recorded_at_idx" ON "access_log"("user_id", "recorded_at");

CREATE OR REPLACE FUNCTION request_records_retention_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% rows cannot be changed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."recorded_at" > CURRENT_TIMESTAMP - INTERVAL '12 months' THEN
    RAISE EXCEPTION '% rows cannot be deleted before they are twelve months old', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS audit_request_context_retention ON "audit_request_context";
CREATE TRIGGER audit_request_context_retention
  BEFORE UPDATE OR DELETE ON "audit_request_context"
  FOR EACH ROW EXECUTE FUNCTION request_records_retention_guard();

DROP TRIGGER IF EXISTS access_log_retention ON "access_log";
CREATE TRIGGER access_log_retention
  BEFORE UPDATE OR DELETE ON "access_log"
  FOR EACH ROW EXECUTE FUNCTION request_records_retention_guard();
