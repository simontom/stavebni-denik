-- CreateTable
CREATE TABLE "visits" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "visitorName" TEXT NOT NULL,
    "visitorRole" TEXT NOT NULL,
    "organization" TEXT,
    "visitedAt" TIMESTAMP(3) NOT NULL,
    "purpose" TEXT NOT NULL,
    "notes" TEXT,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visits_reportId_idx" ON "visits"("reportId");

-- CreateIndex
CREATE INDEX "visits_deletedAt_idx" ON "visits"("deletedAt");

-- CreateIndex
CREATE INDEX "visits_visitedAt_idx" ON "visits"("visitedAt");

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "daily_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
