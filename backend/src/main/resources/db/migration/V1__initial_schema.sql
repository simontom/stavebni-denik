-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('BOSS', 'WORKER', 'INSPECTOR', 'INVESTOR');

-- CreateEnum
CREATE TYPE "RemarkType" AS ENUM ('INSPECTOR_REMARK', 'INVESTOR_NOTE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "nickname" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'WORKER',
    "ckaitNumber" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePwd" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "createdById" UUID,
    "deletedAt" TIMESTAMPTZ,
    "passwordChangedAt" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "revokedAt" TIMESTAMPTZ,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "cadastralArea" TEXT NOT NULL,
    "parcelNumbers" TEXT NOT NULL,
    "permitNumber" TEXT,
    "builder" TEXT NOT NULL,
    "contractor" TEXT NOT NULL,
    "siteManagerId" UUID NOT NULL,
    "tdsName" TEXT,
    "bozpName" TEXT,
    "designerName" TEXT,
    "contractNumber" TEXT,
    "contractDate" TIMESTAMPTZ,
    "designDocVersion" TEXT,
    "designDocDate" TIMESTAMPTZ,
    "gpsLat" DOUBLE PRECISION,
    "gpsLon" DOUBLE PRECISION,
    "startedAt" TIMESTAMPTZ,
    "endedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "createdById" UUID,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_handovers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "projectId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "date" TIMESTAMPTZ NOT NULL,
    "participants" TEXT NOT NULL,
    "meterStates" JSONB,
    "notes" TEXT,
    "createdById" UUID,
    "signedById" UUID,
    "signedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "site_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorized_persons" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "projectId" UUID NOT NULL,
    "linkedUserId" UUID,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "authorization" TEXT,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "authorized_persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "addedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" UUID,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "daily_reports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "projectId" UUID NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "date" TIMESTAMPTZ NOT NULL,
    "authorId" UUID NOT NULL,
    "constructionObj" TEXT,
    "isControlDay" BOOLEAN NOT NULL DEFAULT false,
    "meetingNotes" TEXT,
    "meetingAttendees" JSONB,
    "workSuspended" BOOLEAN NOT NULL DEFAULT false,
    "suspensionReason" TEXT,
    "workersByTrade" JSONB NOT NULL,
    "workDescription" TEXT NOT NULL,
    "materialsIn" TEXT,
    "machinery" TEXT,
    "testsAndChecks" TEXT,
    "safetyNotes" TEXT,
    "defects" TEXT,
    "otherNotes" TEXT,
    "weather" JSONB NOT NULL,
    "signedAt" TIMESTAMPTZ,
    "signedById" UUID,
    "lockedAt" TIMESTAMPTZ,
    "acknowledgedAt" TIMESTAMPTZ,
    "acknowledgedById" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "createdById" UUID,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reportId" UUID NOT NULL,
    "pathOriginal" TEXT NOT NULL,
    "pathThumb" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "capturedAt" TIMESTAMPTZ,
    "gps" JSONB,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remarks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reportId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "type" "RemarkType" NOT NULL DEFAULT 'INSPECTOR_REMARK',
    "text" TEXT NOT NULL,
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "remarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_needs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reportId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "neededBy" TIMESTAMPTZ,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMPTZ,
    "resolvedById" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "createdById" UUID,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "material_needs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addenda" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reportId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_attempts" (
    "id" BIGSERIAL NOT NULL,
    "bucket" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

-- CreateTable
CREATE TABLE "visits" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reportId" UUID NOT NULL,
    "visitorName" TEXT NOT NULL,
    "visitorRole" TEXT NOT NULL,
    "organization" TEXT,
    "visitedAt" TIMESTAMPTZ NOT NULL,
    "purpose" TEXT NOT NULL,
    "notes" TEXT,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "recipientId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "href" TEXT,
    "readAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_nickname_key" ON "users"("nickname");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "projects_deletedAt_idx" ON "projects"("deletedAt");

-- CreateIndex
CREATE INDEX "projects_siteManagerId_idx" ON "projects"("siteManagerId");

-- CreateIndex
CREATE INDEX "site_handovers_projectId_idx" ON "site_handovers"("projectId");

-- CreateIndex
CREATE INDEX "site_handovers_createdById_idx" ON "site_handovers"("createdById");

-- CreateIndex
CREATE INDEX "site_handovers_signedById_idx" ON "site_handovers"("signedById");

-- CreateIndex
CREATE INDEX "site_handovers_deletedAt_idx" ON "site_handovers"("deletedAt");

-- CreateIndex
CREATE INDEX "authorized_persons_projectId_idx" ON "authorized_persons"("projectId");

-- CreateIndex
CREATE INDEX "authorized_persons_linkedUserId_idx" ON "authorized_persons"("linkedUserId");

-- CreateIndex
CREATE INDEX "project_members_userId_idx" ON "project_members"("userId");

-- CreateIndex
CREATE INDEX "daily_reports_deletedAt_idx" ON "daily_reports"("deletedAt");

-- CreateIndex
CREATE INDEX "daily_reports_authorId_idx" ON "daily_reports"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_projectId_date_key" ON "daily_reports"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_projectId_sequenceNumber_key" ON "daily_reports"("projectId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "photos_reportId_idx" ON "photos"("reportId");

-- CreateIndex
CREATE INDEX "photos_deletedAt_idx" ON "photos"("deletedAt");

-- CreateIndex
CREATE INDEX "remarks_reportId_idx" ON "remarks"("reportId");

-- CreateIndex
CREATE INDEX "remarks_deletedAt_idx" ON "remarks"("deletedAt");

-- CreateIndex
CREATE INDEX "material_needs_reportId_idx" ON "material_needs"("reportId");

-- CreateIndex
CREATE INDEX "material_needs_deletedAt_idx" ON "material_needs"("deletedAt");

-- CreateIndex
CREATE INDEX "addenda_reportId_idx" ON "addenda"("reportId");

-- CreateIndex
CREATE INDEX "rate_limit_attempts_bucket_key_created_at_idx" ON "rate_limit_attempts"("bucket", "key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_row_hash_key" ON "audit_log"("row_hash");

-- CreateIndex
CREATE INDEX "audit_log_action_ts_idx" ON "audit_log"("action", "ts");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_ts_idx" ON "audit_log"("actor_id", "ts");

-- CreateIndex
CREATE INDEX "visits_reportId_idx" ON "visits"("reportId");

-- CreateIndex
CREATE INDEX "visits_deletedAt_idx" ON "visits"("deletedAt");

-- CreateIndex
CREATE INDEX "visits_visitedAt_idx" ON "visits"("visitedAt");

-- CreateIndex
CREATE INDEX "notifications_recipientId_readAt_createdAt_idx" ON "notifications"("recipientId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_siteManagerId_fkey" FOREIGN KEY ("siteManagerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_handovers" ADD CONSTRAINT "site_handovers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_handovers" ADD CONSTRAINT "site_handovers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_handovers" ADD CONSTRAINT "site_handovers_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorized_persons" ADD CONSTRAINT "authorized_persons_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "daily_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remarks" ADD CONSTRAINT "remarks_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "daily_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remarks" ADD CONSTRAINT "remarks_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_needs" ADD CONSTRAINT "material_needs_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "daily_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addenda" ADD CONSTRAINT "addenda_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "daily_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addenda" ADD CONSTRAINT "addenda_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "daily_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Auto-update `updatedAt` timestamp
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON "site_handovers"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON "authorized_persons"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON "daily_reports"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON "material_needs"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON "visits"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Immutability hardening for the audit log.
--
-- Two layers of defence:
--   1. A row-level BEFORE-UPDATE/DELETE trigger that raises an exception.
--      Catches the case where the unprivileged `app` role tries to mutate
--      a row through Prisma -- and also any future internal bug.
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
-- Privilege REVOKE -- applied only if a dedicated `app` role exists.
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
