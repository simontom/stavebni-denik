package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.UUID

class CsvExportServiceTest : BaseIntegrationTest() {

    @Test
    fun `exportReportsCsv produces formatted CSV with reports`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "CSV Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val projectId = UUID.fromString(project.id)

        // Two reports. The number of an entry is given when it is signed (decision D11), so the first is signed through
        // the service (number 1) and the second is stored as an entry that was signed as number 2.
        val r1 = DailyReportService.createReport(boss, projectId, "2026-09-27")
        dsl.update(DAILY_REPORTS)
            .set(DAILY_REPORTS.WORKDESCRIPTION, "Vykopove prace pro kanalizaci \"usek A\"")
            .where(DAILY_REPORTS.ID.eq(UUID.fromString(r1.id)))
            .execute()
        DailyReportService.signReport(boss, UUID.fromString(r1.id))

        val r2Id = UUID.randomUUID()
        dsl.insertInto(DAILY_REPORTS)
            .set(DAILY_REPORTS.ID, r2Id)
            .set(DAILY_REPORTS.PROJECTID, projectId)
            .set(DAILY_REPORTS.AUTHORID, boss.id)
            .set(DAILY_REPORTS.DATE, java.time.LocalDate.parse("2026-09-28"))
            .set(DAILY_REPORTS.SEQUENCENUMBER, 2)
            .set(DAILY_REPORTS.LOCKEDAT, java.time.OffsetDateTime.now())
            .set(DAILY_REPORTS.WORKERSBYTRADE, org.jooq.JSONB.valueOf("[]"))
            .set(DAILY_REPORTS.WORKDESCRIPTION, "Betonaz podkladniho betonu")
            .execute()

        val csv = CsvExportService.exportReportsCsv(dsl, projectId)
        assertTrue(csv.startsWith("Sequence Number,Date,Work Description,Work Suspended\n"))
        assertTrue(csv.contains("Vykopove prace pro kanalizaci \"\"usek A\"\""))
        assertTrue(csv.contains("Betonaz podkladniho betonu"))
        // The report date is a calendar date, exported as YYYY-MM-DD.
        assertTrue(csv.contains("\n1,2026-09-27,"), csv)
        assertTrue(csv.contains("\n2,2026-09-28,"), csv)
    }
}
