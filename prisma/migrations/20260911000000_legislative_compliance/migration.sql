-- CreateEnum
CREATE TYPE "RemarkType" AS ENUM ('INSPECTOR_REMARK', 'INVESTOR_NOTE');

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('BOSS', 'WORKER', 'INSPECTOR', 'INVESTOR');
ALTER TABLE "public"."users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TABLE "project_members" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "public"."Role_old";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'WORKER';
COMMIT;

-- AlterTable
ALTER TABLE "daily_reports" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedById" TEXT,
ADD COLUMN     "constructionObj" TEXT,
ADD COLUMN     "isControlDay" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "meetingAttendees" JSONB,
ADD COLUMN     "meetingNotes" TEXT,
ADD COLUMN     "sequenceNumber" INTEGER NOT NULL,
ADD COLUMN     "suspensionReason" TEXT,
ADD COLUMN     "workSuspended" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "contractDate" TIMESTAMP(3),
ADD COLUMN     "contractNumber" TEXT,
ADD COLUMN     "designDocDate" TIMESTAMP(3),
ADD COLUMN     "designDocVersion" TEXT;

-- AlterTable
ALTER TABLE "remarks" ADD COLUMN     "type" "RemarkType" NOT NULL DEFAULT 'INSPECTOR_REMARK';

-- CreateTable
CREATE TABLE "site_handovers" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "participants" TEXT NOT NULL,
    "meterStates" JSONB,
    "notes" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "site_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorized_persons" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkedUserId" TEXT,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "authorization" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "authorized_persons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_handovers_projectId_idx" ON "site_handovers"("projectId");

-- CreateIndex
CREATE INDEX "site_handovers_deletedAt_idx" ON "site_handovers"("deletedAt");

-- CreateIndex
CREATE INDEX "authorized_persons_projectId_idx" ON "authorized_persons"("projectId");

-- CreateIndex
CREATE INDEX "authorized_persons_linkedUserId_idx" ON "authorized_persons"("linkedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_projectId_sequenceNumber_key" ON "daily_reports"("projectId", "sequenceNumber");

-- AddForeignKey
ALTER TABLE "site_handovers" ADD CONSTRAINT "site_handovers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorized_persons" ADD CONSTRAINT "authorized_persons_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

