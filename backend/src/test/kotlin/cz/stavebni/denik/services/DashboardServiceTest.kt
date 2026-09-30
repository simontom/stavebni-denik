package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.util.UUID

class DashboardServiceTest : BaseIntegrationTest() {

    @Test
    fun `getDashboardStats calculates active projects and unacknowledged reports`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)

        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Dashboard Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val projectId = UUID.fromString(project.id)

        // Initial stats: 1 active project, 0 pending reports
        val stats1 = DashboardService.getDashboardStats(boss)
        assertEquals(1, stats1.activeProjects)
        assertEquals(0, stats1.pendingUnacknowledgedReports)

        // Create a report and sign it
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28")
        val reportId = UUID.fromString(report.id)

        // Mark report as signed by boss
        dsl.update(DAILY_REPORTS)
            .set(DAILY_REPORTS.SIGNEDBYID, boss.id)
            .where(DAILY_REPORTS.ID.eq(reportId))
            .execute()

        // Stats should now report 1 pending unacknowledged report
        val stats2 = DashboardService.getDashboardStats(boss)
        assertEquals(1, stats2.activeProjects)
        assertEquals(1, stats2.pendingUnacknowledgedReports)

        // Admin stats should also reflect it
        val adminStats = DashboardService.getDashboardStats(admin)
        assertEquals(1, adminStats.activeProjects)
        assertEquals(1, adminStats.pendingUnacknowledgedReports)
    }
}
