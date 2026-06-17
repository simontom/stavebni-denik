-- CreateTable
CREATE TABLE "daily_reports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "authorId" TEXT NOT NULL,
    "workersByTrade" JSONB NOT NULL,
    "workDescription" TEXT NOT NULL,
    "materialsIn" TEXT,
    "machinery" TEXT,
    "testsAndChecks" TEXT,
    "safetyNotes" TEXT,
    "defects" TEXT,
    "otherNotes" TEXT,
    "weather" JSONB NOT NULL,
    "signedAt" TIMESTAMP(3),
    "signedById" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "pathOriginal" TEXT NOT NULL,
    "pathThumb" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "gps" JSONB,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remarks" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "remarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_needs" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "neededBy" TIMESTAMP(3),
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "material_needs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addenda" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addenda_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_reports_deletedAt_idx" ON "daily_reports"("deletedAt");

-- CreateIndex
CREATE INDEX "daily_reports_authorId_idx" ON "daily_reports"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_projectId_date_key" ON "daily_reports"("projectId", "date");

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

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
