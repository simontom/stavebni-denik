package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import kotlinx.coroutines.runBlocking
import org.jooq.JSONB
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class ValidationServiceTest : BaseIntegrationTest() {

    @Test
    fun `validateReport checks weather and work description`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Validation Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
        val reportId = UUID.fromString(report.id)

        // Initial state has empty weather and blank work description
        val errors1 = ValidationService.validateReport(dsl, reportId)
        assertEquals(2, errors1.size)
        assertTrue(errors1.contains("Weather information is missing."))
        assertTrue(errors1.contains("Work description is missing."))

        // Populate weather and work description
        dsl.update(DAILY_REPORTS)
            .set(DAILY_REPORTS.WEATHER, JSONB.valueOf("{\"temperature\": 20}"))
            .set(DAILY_REPORTS.WORKDESCRIPTION, "Betonovani zakladu")
            .where(DAILY_REPORTS.ID.eq(reportId))
            .execute()

        val errors2 = ValidationService.validateReport(dsl, reportId)
        assertTrue(errors2.isEmpty())
    }
}
