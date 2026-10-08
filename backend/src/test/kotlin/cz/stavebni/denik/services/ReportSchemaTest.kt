package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import kotlinx.coroutines.runBlocking
import org.jooq.JSONB
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Guarantees of the V1 schema that the diary's legal records rely on: a report
 * date is a calendar day, one live report per project and day, and a project or
 * report row cannot be hard-deleted while records hang off it.
 */
class ReportSchemaTest : BaseIntegrationTest() {

    private suspend fun createProjectId(boss: cz.stavebni.denik.domain.SessionUser): UUID {
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Schema Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor",
                siteManagerId = boss.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private fun insertLiveReport(projectId: UUID, authorId: UUID, date: String, sequence: Int) {
        dsl.insertInto(DAILY_REPORTS)
            .set(DAILY_REPORTS.PROJECTID, projectId)
            .set(DAILY_REPORTS.AUTHORID, authorId)
            .set(DAILY_REPORTS.DATE, LocalDate.parse(date))
            .set(DAILY_REPORTS.SEQUENCENUMBER, sequence)
            .set(DAILY_REPORTS.WORKERSBYTRADE, JSONB.valueOf("[]"))
            .set(DAILY_REPORTS.WORKDESCRIPTION, "raw insert")
            .execute()
    }

    // --- report date is a calendar day ---------------------------------------------------

    @Test
    fun `report date is stored as the calendar day and a time part is ignored`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProjectId(boss)

        val report = DailyReportService.createReport(boss, projectId, "2026-09-28T23:30:00+02:00")

        assertEquals("2026-09-28", report.date)
        val stored = dsl.select(DAILY_REPORTS.DATE).from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(UUID.fromString(report.id))).fetchOne(DAILY_REPORTS.DATE)
        assertEquals(LocalDate.of(2026, 9, 28), stored)
    }

    @Test
    fun `report can be fetched by its calendar day`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProjectId(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28")

        val byDate = DailyReportService.getReport(projectId, "2026-09-28")

        assertEquals(created.id, byDate?.id)
    }

    @Test
    fun `a new report has no weather snapshot yet`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProjectId(boss)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28")

        val weather = dsl.select(DAILY_REPORTS.WEATHER).from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(UUID.fromString(report.id))).fetchOne(DAILY_REPORTS.WEATHER)

        assertNull(weather, "no weather has been captured, so the column must be NULL, not a '{}' placeholder")
        assertTrue(ValidationService.validateReport(dsl, UUID.fromString(report.id)).any { it.contains("Weather") })
    }

    // --- one live report per project and day ---------------------------------------------

    @Test
    fun `a second live report for the same project and day is rejected by the database`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProjectId(boss)
        DailyReportService.createReport(boss, projectId, "2026-09-28")

        assertThrows<DataAccessException> { insertLiveReport(projectId, boss.id, "2026-09-28", sequence = 99) }

        assertEquals(1, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)))
    }

    @Test
    fun `the same day in another project is allowed`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val first = createProjectId(boss)
        val second = createProjectId(boss)

        DailyReportService.createReport(boss, first, "2026-09-28")
        DailyReportService.createReport(boss, second, "2026-09-28")

        assertEquals(1, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(first)))
        assertEquals(1, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(second)))
    }

    @Test
    fun `a soft-deleted report does not block a new report for that day`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProjectId(boss)
        val first = DailyReportService.createReport(boss, projectId, "2026-09-28")
        dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.DELETEDAT, OffsetDateTime.now())
            .where(DAILY_REPORTS.ID.eq(UUID.fromString(first.id))).execute()

        val second = DailyReportService.createReport(boss, projectId, "2026-09-28")

        assertNotEquals(first.id, second.id)
        assertEquals(2, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)))
        assertEquals(1, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId).and(DAILY_REPORTS.DELETEDAT.isNull)))
    }

    // --- legal records cannot be hard-deleted --------------------------------------------

    @Test
    fun `a project that has reports cannot be hard-deleted`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProjectId(boss)
        DailyReportService.createReport(boss, projectId, "2026-09-28")

        assertThrows<DataAccessException> {
            dsl.deleteFrom(PROJECTS).where(PROJECTS.ID.eq(projectId)).execute()
        }

        assertEquals(1, dsl.fetchCount(PROJECTS, PROJECTS.ID.eq(projectId)))
        assertEquals(1, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)))
    }

    @Test
    fun `foreign keys of the legal records restrict deletes while membership and sessions cascade`() {
        val rules = dsl.fetch("select conname, confdeltype from pg_constraint where contype = 'f'")
            .associate { it.get("conname", String::class.java) to it.get("confdeltype", String::class.java) }

        val restricted = listOf(
            "site_handovers_projectId_fkey", "authorized_persons_projectId_fkey", "daily_reports_projectId_fkey",
            "photos_reportId_fkey", "remarks_reportId_fkey", "material_needs_reportId_fkey",
            "addenda_reportId_fkey", "visits_reportId_fkey"
        )
        for (name in restricted) {
            assertEquals("r", rules[name], "$name must be ON DELETE RESTRICT")
        }
        val cascading = listOf(
            "sessions_userId_fkey", "project_members_projectId_fkey", "project_members_userId_fkey",
            "notifications_recipientId_fkey"
        )
        for (name in cascading) {
            assertEquals("c", rules[name], "$name must stay ON DELETE CASCADE")
        }
    }

    // --- defaults that V2 used to add (now part of V1) -----------------------------------

    @Test
    fun `updatedAt columns and the member role have database defaults`() {
        val tables = listOf(
            "users", "projects", "site_handovers", "authorized_persons", "daily_reports", "material_needs", "visits"
        )
        for (table in tables) {
            val default = dsl.fetchValue(
                "select column_default from information_schema.columns where table_name = ? and column_name = 'updatedAt'",
                table
            )
            assertNotNull(default, "$table.updatedAt needs a default")
        }
        val roleDefault = dsl.fetchValue(
            "select column_default from information_schema.columns where table_name = 'project_members' and column_name = 'role'"
        )
        assertTrue(roleDefault.toString().contains("BOSS"), "project_members.role default was: $roleDefault")
    }
}
