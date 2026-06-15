-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "prev_hash" TEXT NOT NULL,
    "row_hash" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_row_hash_key" ON "audit_log"("row_hash");

-- CreateIndex
CREATE INDEX "audit_log_action_ts_idx" ON "audit_log"("action", "ts");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_ts_idx" ON "audit_log"("actor_id", "ts");

-- ---------------------------------------------------------------------------
-- Immutability hardening for the audit log.
--
-- Two layers of defence:
--   1. A row-level BEFORE-UPDATE/DELETE trigger that raises an exception.
--      Catches the case where the unprivileged `app` role tries to mutate
--      a row through Prisma — and also any future internal bug.
--   2. Privilege REVOKE on the `app` role (where present). The migrator
--      runs as a privileged user, but the runtime app must not be able
--      to UPDATE/DELETE these rows.
--
-- The trigger is the authoritative guard; the grants are a belt to the
-- braces. Both are idempotent.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_block_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log rows are append-only (operation: %); use INSERT only.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_update ON "audit_log";
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

DROP TRIGGER IF EXISTS audit_log_no_delete ON "audit_log";
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- ---------------------------------------------------------------------------
-- Privilege REVOKE — applied only if a dedicated `app` role exists.
-- During local dev we often run as the superuser and skip this; production
-- deploys should run the bootstrap SQL in `scripts/sql/bootstrap-app-role.sql`
-- (see README) before applying migrations.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON "audit_log" TO app';
    EXECUTE 'REVOKE UPDATE, DELETE ON "audit_log" FROM app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app';
  END IF;
END;
$$;
