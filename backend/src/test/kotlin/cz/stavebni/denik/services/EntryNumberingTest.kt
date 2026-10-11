package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** Decision D11: the number of an entry is given when it is signed, so the signed entries have no gaps. */
class EntryNumberingTest : BaseIntegrationTest() {

    private suspend fun project(owner: SessionUser): UUID =
        UUID.fromString(
            ProjectService.createProject(
                owner,
                ProjectDto(
                    id = "", name = "Číslování", address = "A", cadastralArea = "C", parcelNumbers = "1",
                    builder = "B", contractor = "C", siteManagerId = owner.id.toString(),
                )
            ).id
        )

    private suspend fun draft(user: SessionUser, projectId: UUID, date: String): UUID =
        UUID.fromString(DailyReportService.createReport(user, projectId, date, workDescription = "Práce $date").id)

    private fun numberOf(reportId: UUID): Int? =
        dsl.select(DAILY_REPORTS.SEQUENCENUMBER).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchSingle(DAILY_REPORTS.SEQUENCENUMBER)

    @Test
    fun `a draft has no number and the number is given at signing, in the order of signing`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val first = draft(boss, projectId, "2026-09-26")
        val second = draft(boss, projectId, "2026-09-27")
        val third = draft(boss, projectId, "2026-09-28")

        listOf(first, second, third).forEach { assertNull(numberOf(it), "a draft has no number yet") }

        // Signed in a different order than created: the numbers follow the signing.
        DailyReportService.signReport(boss, third)
        DailyReportService.signReport(boss, first)
        DailyReportService.signReport(boss, second)

        assertEquals(1, numberOf(third))
        assertEquals(2, numberOf(first))
        assertEquals(3, numberOf(second))
    }

    @Test
    fun `drafts that come and go leave no gap in the signed entries`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val kept = draft(boss, projectId, "2026-09-26")
        val abandoned = draft(boss, projectId, "2026-09-27")
        val lastOne = draft(boss, projectId, "2026-09-28")
        dsl.execute("""update daily_reports set "deletedAt" = now() where id = ?""", abandoned)

        DailyReportService.signReport(boss, kept)
        DailyReportService.signReport(boss, lastOne)

        assertEquals(listOf(1, 2), listOf(numberOf(kept), numberOf(lastOne)), "no hole where the abandoned draft was")
    }

    @Test
    fun `every project is numbered on its own`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val one = project(boss)
        val two = project(boss)
        val a = draft(boss, one, "2026-09-28")
        val b = draft(boss, two, "2026-09-28")

        DailyReportService.signReport(boss, a)
        DailyReportService.signReport(boss, b)

        assertEquals(1, numberOf(a))
        assertEquals(1, numberOf(b))
    }

    @Test
    fun `entries signed at the same moment get distinct consecutive numbers`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val ids = (1..8).map { draft(boss, projectId, "2026-09-%02d".format(it)) }

        coroutineScope { ids.map { async { DailyReportService.signReport(boss, it) } }.awaitAll() }

        assertEquals((1..8).toList(), ids.map { numberOf(it)!! }.sorted())
    }

    @Test
    fun `the number is part of what the signature covers`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val id = draft(boss, projectId, "2026-09-28")
        DailyReportService.signReport(boss, id)
        assertEquals(true, ReportSignature.check(dsl, id).contentMatches)

        // Changing the stored number behind the application's back (the triggers disabled) breaks the signature.
        dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
        try {
            dsl.execute("""update daily_reports set "sequenceNumber" = 41 where id = ?""", id)
        } finally {
            dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
        }

        assertEquals(false, ReportSignature.check(dsl, id).contentMatches)
    }

    @Test
    fun `the entry the API returns carries its number once it is signed`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val id = draft(boss, projectId, "2026-09-28")
        assertNull(DailyReportService.getReport(projectId, id.toString())!!.sequenceNumber)

        DailyReportService.signReport(boss, id)

        assertEquals(1, DailyReportService.getReport(projectId, id.toString())!!.sequenceNumber)
    }

    @Test
    fun `the database refuses a wrong number at signing, a number on a draft and a signature without a number`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val id = draft(boss, projectId, "2026-09-28")

        // Not the next number of the project.
        assertThrows(DataAccessException::class.java) {
            dsl.execute("""update daily_reports set "lockedAt" = now(), "sequenceNumber" = 5 where id = ?""", id)
        }
        // No number at all.
        assertThrows(DataAccessException::class.java) {
            dsl.execute("""update daily_reports set "lockedAt" = now() where id = ?""", id)
        }
        // A draft that is given a number without being signed.
        assertThrows(DataAccessException::class.java) {
            dsl.execute("""update daily_reports set "sequenceNumber" = 1 where id = ?""", id)
        }
        assertNull(numberOf(id))
        assertNull(dsl.select(DAILY_REPORTS.LOCKEDAT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(id)).fetchSingle(DAILY_REPORTS.LOCKEDAT))
    }

    @Test
    fun `the CSV leaves the number of a draft empty`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val signed = draft(boss, projectId, "2026-09-27")
        draft(boss, projectId, "2026-09-28")
        DailyReportService.signReport(boss, signed)

        val lines = CsvExportService.exportReportsCsv(dsl, projectId).trim().lines()

        assertTrue(lines[1].startsWith("1,2026-09-27,"), lines[1])
        assertTrue(lines[2].startsWith(",2026-09-28,"), "a draft has no number: ${lines[2]}")
    }
}
