package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.module
import cz.stavebni.denik.util.Dates
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

/**
 * Decision D10: a new entry is for today or since the previous working day; an earlier day is a flagged late entry
 * with a reason; the future is refused.
 */
class EntryDateWindowTest : BaseIntegrationTest() {

    private val originalClock = DailyReportService.clock

    /** Wednesday 30 September 2026, 10:00 in Prague (summer time): the previous working day is Tuesday the 29th. */
    private fun clockAt(instant: String) = Clock.fixed(Instant.parse(instant), Dates.PRAGUE)

    @BeforeEach
    fun windowOn() {
        System.setProperty("ENTRY_DATE_WINDOW", "on")
        DailyReportService.clock = clockAt("2026-09-30T08:00:00Z")
    }

    @AfterEach
    fun windowOff() {
        System.setProperty("ENTRY_DATE_WINDOW", "off")
        DailyReportService.clock = originalClock
    }

    private suspend fun project(owner: SessionUser): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = "Window Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private fun row(id: String) = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(id))).fetchOne()!!

    // --- the arithmetic -------------------------------------------------------------------------

    @Test
    fun `the previous working day skips weekends`() {
        fun prev(day: String) = Dates.previousWorkingDay(LocalDate.parse(day)).toString()

        assertEquals("2026-09-28", prev("2026-09-29")) // Tuesday -> Monday
        assertEquals("2026-09-29", prev("2026-09-30")) // Wednesday -> Tuesday
        assertEquals("2026-10-02", prev("2026-10-05")) // Monday -> Friday
        assertEquals("2026-10-02", prev("2026-10-04")) // Sunday -> Friday
        assertEquals("2026-10-02", prev("2026-10-03")) // Saturday -> Friday
    }

    // --- the rule -------------------------------------------------------------------------------

    @Test
    fun `today and the previous working day are on time and not flagged`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        val today = DailyReportService.createReport(boss, projectId, "2026-09-30")
        val yesterday = DailyReportService.createReport(boss, projectId, "2026-09-29")

        assertFalse(today.isLateEntry)
        assertFalse(yesterday.isLateEntry)
        assertNull(yesterday.lateEntryReason)
    }

    @Test
    fun `an earlier day needs a reason and is then flagged, stored and audited`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        val refused = assertThrows<IllegalArgumentException> { DailyReportService.createReport(boss, projectId, "2026-09-28") }
        assertTrue(refused.message!!.contains("pozdní zápis"), refused.message)
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS))

        val late = DailyReportService.createReport(boss, projectId, "2026-09-28", lateEntryReason = "  Deník byl na jiné stavbě  ")

        assertTrue(late.isLateEntry)
        assertEquals("Deník byl na jiné stavbě", late.lateEntryReason)
        assertTrue(row(late.id).islateentry!!)
        val snapshot = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.create")).fetchOne()!!.get(AUDIT_LOG.AFTER)!!.data()
        val after = Json.parseToJsonElement(snapshot).jsonObject
        assertEquals("true", after["isLateEntry"]!!.jsonPrimitive.content)
        assertEquals("Deník byl na jiné stavbě", after["lateEntryReason"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a blank or oversized reason does not make a late entry`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        assertThrows<IllegalArgumentException> { DailyReportService.createReport(boss, projectId, "2026-09-28", lateEntryReason = "   ") }
        val tooLong = "x".repeat(DailyReportService.MAX_LATE_REASON_CHARS + 1)
        assertThrows<IllegalArgumentException> { DailyReportService.createReport(boss, projectId, "2026-09-28", lateEntryReason = tooLong) }
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS))
    }

    @Test
    fun `a reason for an entry that is on time is ignored`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        val onTime = DailyReportService.createReport(boss, projectId, "2026-09-30", lateEntryReason = "není potřeba")

        assertFalse(onTime.isLateEntry)
        assertNull(onTime.lateEntryReason)
    }

    @Test
    fun `a day in the future is refused, with or without a reason`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        val refused = assertThrows<IllegalArgumentException> { DailyReportService.createReport(boss, projectId, "2026-10-01", lateEntryReason = "předem") }
        assertTrue(refused.message!!.contains("budoucí"), refused.message)
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS))
    }

    @Test
    fun `on a Monday the weekend and Friday are still on time`() = runBlocking {
        DailyReportService.clock = clockAt("2026-10-05T08:00:00Z") // Monday
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        for (day in listOf("2026-10-05", "2026-10-04", "2026-10-03", "2026-10-02")) {
            assertFalse(DailyReportService.createReport(boss, projectId, day).isLateEntry, day)
        }
        assertThrows<IllegalArgumentException> { DailyReportService.createReport(boss, projectId, "2026-10-01") } // Thursday
    }

    @Test
    fun `just after midnight in Prague, today is already the new day`() = runBlocking {
        // 22:30 UTC on the 29th is 00:30 on the 30th in Prague: the 30th is today, the 28th is the previous working day's day before.
        DailyReportService.clock = clockAt("2026-09-29T22:30:00Z")
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        assertFalse(DailyReportService.createReport(boss, projectId, "2026-09-30").isLateEntry)
        assertFalse(DailyReportService.createReport(boss, projectId, "2026-09-29").isLateEntry)
    }

    @Test
    fun `correcting an existing late entry does not ask for the reason again`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        DailyReportService.createReport(boss, projectId, "2026-09-28", lateEntryReason = "Důvod")

        val saved = DailyReportService.saveReport(boss, projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Oprava"))

        assertEquals("Oprava", saved.workDescription)
        assertTrue(saved.isLateEntry)
        assertEquals("Důvod", saved.lateEntryReason)
    }

    @Test
    fun `with the window switched off any date is accepted`() = runBlocking {
        System.setProperty("ENTRY_DATE_WINDOW", "off")
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        assertFalse(DailyReportService.createReport(boss, projectId, "2020-01-01").isLateEntry)
        assertFalse(DailyReportService.createReport(boss, projectId, "2030-01-01").isLateEntry)
    }

    // --- the database ---------------------------------------------------------------------------

    @Test
    fun `the database refuses a flagged entry without a reason`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-30")

        assertThrows<DataAccessException> {
            dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.ISLATEENTRY, true).where(DAILY_REPORTS.ID.eq(UUID.fromString(report.id))).execute()
        }
        assertThrows<DataAccessException> {
            dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.ISLATEENTRY, true).set(DAILY_REPORTS.LATEENTRYREASON, "   ")
                .where(DAILY_REPORTS.ID.eq(UUID.fromString(report.id))).execute()
        }
        assertFalse(row(report.id).islateentry!!)
    }

    // --- the API --------------------------------------------------------------------------------

    @Test
    fun `the API refuses an entry for an earlier day without a reason and accepts it with one`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        val without = client.post("/api/projects/$projectId/reports/2026-09-25") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody("""{"workDescription":"Zpětně"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, without.status)
        assertTrue(without.bodyAsText().contains("důvod pozdního zápisu"), without.bodyAsText())

        val with = client.post("/api/projects/$projectId/reports/2026-09-25") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody("""{"workDescription":"Zpětně","lateEntryReason":"Dovolená stavbyvedoucího"}""")
        }
        assertEquals(HttpStatusCode.OK, with.status, with.bodyAsText())
        val json = Json.parseToJsonElement(with.bodyAsText()).jsonObject
        assertEquals("true", json["isLateEntry"]!!.jsonPrimitive.content)
        assertEquals("Dovolená stavbyvedoucího", json["lateEntryReason"]!!.jsonPrimitive.content)

        val read = client.get("/api/projects/$projectId/reports/2026-09-25") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertTrue(read.bodyAsText().contains("\"isLateEntry\":true"), read.bodyAsText())
    }

    @Test
    fun `the API creates today's entry as before`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        val response = client.post("/api/projects/$projectId/reports") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody("""{"workDescription":"Dnes"}""")
        }

        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        assertEquals("2026-09-30", Json.parseToJsonElement(response.bodyAsText()).jsonObject["date"]!!.jsonPrimitive.content)
    }
}
