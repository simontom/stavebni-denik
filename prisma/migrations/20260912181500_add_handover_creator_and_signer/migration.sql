-- AlterTable
ALTER TABLE "site_handovers" ADD COLUMN "createdById" TEXT,
ADD COLUMN "signedById" TEXT;

-- CreateIndex
CREATE INDEX "site_handovers_createdById_idx" ON "site_handovers"("createdById");

-- CreateIndex
CREATE INDEX "site_handovers_signedById_idx" ON "site_handovers"("signedById");

-- AddForeignKey
ALTER TABLE "site_handovers" ADD CONSTRAINT "site_handovers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_handovers" ADD CONSTRAINT "site_handovers_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;