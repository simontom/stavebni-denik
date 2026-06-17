-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
