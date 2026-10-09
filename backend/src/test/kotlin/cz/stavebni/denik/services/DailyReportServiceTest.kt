package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

class DailyReportServiceTest : BaseIntegrationTest() {

    @Test
    fun `BOSS can create and lock daily report`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Report Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val projectId = UUID.fromString(project.id)

        // 1. Create Report
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28")
        assertNotNull(report.id)
        assertFalse(report.isLocked)

        val reportId = UUID.fromString(report.id)
        val reportInDb = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()
        assertNotNull(reportInDb)
        assertNull(reportInDb!!.get(DAILY_REPORTS.LOCKEDAT))

        // 2. Lock Report
        DailyReportService.lockReport(boss, reportId)

        val lockedReportInDb = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()
        assertNotNull(lockedReportInDb)
        assertNotNull(lockedReportInDb!!.get(DAILY_REPORTS.LOCKEDAT))

        // Verify audit trail for create and lock
        val auditActions = dsl.select(AUDIT_LOG.ACTION)
            .from(AUDIT_LOG)
            .orderBy(AUDIT_LOG.ID.asc())
            .fetch(AUDIT_LOG.ACTION)
        assertTrue(auditActions.contains("report.create"))
        assertTrue(auditActions.contains("report.lock"))
    }

    @Test
    fun `WORKER cannot lock daily report`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            val worker = createTestUser(role = Role.WORKER)

            val project = ProjectService.createProject(boss, ProjectDto(
                id = "", name = "Worker Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            ))
            val projectId = UUID.fromString(project.id)

            // Add worker to project
            addMember(projectId, worker)

            val report = DailyReportService.createReport(boss, projectId, "2026-09-28")
            val reportId = UUID.fromString(report.id)

            // Worker attempts to lock report -> ForbiddenException
            assertThrows<ForbiddenException> {
                runBlocking {
                    DailyReportService.lockReport(worker, reportId)
                }
            }
        }
    }
}

