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

        // Create two reports
        val r1 = DailyReportService.createReport(boss, projectId, "2026-09-27")
        val r2Id = UUID.randomUUID()
        dsl.insertInto(DAILY_REPORTS)
            .set(DAILY_REPORTS.ID, r2Id)
            .set(DAILY_REPORTS.PROJECTID, projectId)
            .set(DAILY_REPORTS.AUTHORID, boss.id)
            .set(DAILY_REPORTS.DATE, java.time.OffsetDateTime.parse("2026-09-28T00:00:00Z"))
            .set(DAILY_REPORTS.SEQUENCENUMBER, 2)
            .set(DAILY_REPORTS.WORKERSBYTRADE, org.jooq.JSONB.valueOf("[]"))
            .set(DAILY_REPORTS.WORKDESCRIPTION, "Betonaz podkladniho betonu")
            .set(DAILY_REPORTS.WEATHER, org.jooq.JSONB.valueOf("{}"))
            .execute()

        dsl.update(DAILY_REPORTS)
            .set(DAILY_REPORTS.WORKDESCRIPTION, "Vykopove prace pro kanalizaci \"usek A\"")
            .where(DAILY_REPORTS.ID.eq(UUID.fromString(r1.id)))
            .execute()

        val csv = CsvExportService.exportReportsCsv(dsl, projectId)
        assertTrue(csv.startsWith("Sequence Number,Date,Work Description,Work Suspended\n"))
        assertTrue(csv.contains("Vykopove prace pro kanalizaci \"\"usek A\"\""))
        assertTrue(csv.contains("Betonaz podkladniho betonu"))
    }
}
