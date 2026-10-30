package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.module
import cz.stavebni.denik.util.Dates
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Instant
import java.util.UUID

/**
 * The list of projects says what state today's entry is in (backlog B4), so that the page can say "Dnes: nezapsáno" and link to the
 * day. "Today" is the day on a clock in Prague, decided by the server, and it is the day the answer names.
 */
class ProjectTodayEntryTest : BaseIntegrationTest() {

    private val originalClock = DailyReportService.clock

    /** Thursday 22 October 2026, 10:00 in Prague (summer time ended on 25 October, so this is still UTC+2). */
    @BeforeEach
    fun clockAtNoon() {
        DailyReportService.clock = Clock.fixed(Instant.parse("2026-10-22T08:00:00Z"), Dates.PRAGUE)
    }

    @AfterEach
    fun restoreClock() {
        DailyReportService.clock = originalClock
    }

    private suspend fun project(owner: SessionUser, name: String = "Projekt"): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = name, address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = owner.id.toString(),
            ),
        )
        return UUID.fromString(project.id)
    }

    private fun today(user: SessionUser, projectId: UUID): TodayEntryDto? =
        ProjectService.listProjects(dsl, user).single { it.id == projectId.toString() }.todayEntry

    private suspend fun entry(owner: SessionUser, projectId: UUID, day: String, sign: Boolean = false): DailyReportDto {
        val saved = DailyReportService.saveReport(owner, projectId, day, DailyReportService.ReportInput(workDescription = "Práce", lateEntryReason = "pozdě"))
        if (sign) signUnchecked(owner, UUID.fromString(saved.id))
        return saved
    }

    @Test
    fun `a project without an entry for today says none, and names the day`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)

        assertEquals(TodayEntryDto(date = "2026-10-22", state = TodayEntryState.NONE, reportId = null), today(boss, p))
    }

    @Test
    fun `an entry being written is a draft, with its id`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)
        val saved = entry(boss, p, "2026-10-22")

        assertEquals(TodayEntryDto("2026-10-22", TodayEntryState.DRAFT, saved.id), today(boss, p))
    }

    @Test
    fun `a signed entry is signed, with its id`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)
        val saved = entry(boss, p, "2026-10-22", sign = true)

        assertEquals(TodayEntryDto("2026-10-22", TodayEntryState.SIGNED, saved.id), today(boss, p))
    }

    @Test
    fun `only today counts, not yesterday, not tomorrow, and not an entry that was removed`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)
        entry(boss, p, "2026-10-21", sign = true)
        assertEquals(TodayEntryState.NONE, today(boss, p)!!.state, "yesterday's entry is not today's")

        val removed = entry(boss, p, "2026-10-22")
        dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.DELETEDAT, java.time.OffsetDateTime.now()).where(DAILY_REPORTS.ID.eq(UUID.fromString(removed.id))).execute()
        assertEquals(TodayEntryState.NONE, today(boss, p)!!.state, "a removed entry is no entry")
    }

    @Test
    fun `each project has its own state, and an entry of another project does not count`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val withEntry = project(boss, "Má záznam")
        val without = project(boss, "Nemá záznam")
        val signedOne = project(boss, "Podepsaný")
        val draft = entry(boss, withEntry, "2026-10-22")
        val signed = entry(boss, signedOne, "2026-10-22", sign = true)

        assertEquals(TodayEntryDto("2026-10-22", TodayEntryState.DRAFT, draft.id), today(boss, withEntry))
        assertEquals(TodayEntryDto("2026-10-22", TodayEntryState.NONE, null), today(boss, without))
        assertEquals(TodayEntryDto("2026-10-22", TodayEntryState.SIGNED, signed.id), today(boss, signedOne))
    }

    @Test
    fun `today is the day in Prague, not in UTC`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)
        val onThe22nd = entry(boss, p, "2026-10-22")
        val onThe21st = entry(boss, p, "2026-10-21")

        // 22:30 UTC on the 21st is 00:30 on the 22nd in Prague.
        DailyReportService.clock = Clock.fixed(Instant.parse("2026-10-21T22:30:00Z"), Dates.PRAGUE)
        assertEquals(TodayEntryDto("2026-10-22", TodayEntryState.DRAFT, onThe22nd.id), today(boss, p))

        // 21:30 UTC on the 21st is still the 21st (23:30) in Prague.
        DailyReportService.clock = Clock.fixed(Instant.parse("2026-10-21T21:30:00Z"), Dates.PRAGUE)
        assertEquals(TodayEntryDto("2026-10-21", TodayEntryState.DRAFT, onThe21st.id), today(boss, p))
    }

    @Test
    fun `a member sees the state of their own projects only, an administrator who is no member sees every project`() = runBlocking<Unit> {
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val other = createTestUser(nickname = "other", role = Role.BOSS)
        val admin = createTestUser(nickname = "admin", role = Role.WORKER, isAdmin = true)
        val mine = project(boss, "Moje")
        val theirs = project(other, "Cizí")
        entry(other, theirs, "2026-10-22", sign = true)

        assertEquals(listOf(mine.toString()), ProjectService.listProjects(dsl, boss).map { it.id }, "the other project is not in the list, so nor is its state")
        assertEquals(TodayEntryState.SIGNED, today(admin, theirs)!!.state)
        assertEquals(TodayEntryState.NONE, today(admin, mine)!!.state)
    }

    @Test
    fun `a single project and the answer to a change do not carry it`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)

        assertNull(ProjectService.getProject(dsl, boss, p).todayEntry)
    }

    @Test
    fun `over the route the list carries the state, and a stranger gets no project at all`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val stranger = createTestUser(nickname = "stranger", role = Role.INVESTOR)
        val p = runBlocking { project(boss) }
        val saved = runBlocking { entry(boss, p, "2026-10-22") }

        val body = client.get("/api/projects") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}") }.bodyAsText()
        val today = Json.parseToJsonElement(body).jsonArray.single().jsonObject["todayEntry"]!!.jsonObject
        assertEquals("2026-10-22", today["date"]!!.jsonPrimitive.content)
        assertEquals("DRAFT", today["state"]!!.jsonPrimitive.content)
        assertEquals(saved.id, today["reportId"]!!.jsonPrimitive.content)

        val seenByStranger = client.get("/api/projects") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(stranger)}") }.bodyAsText()
        assertEquals(0, Json.parseToJsonElement(seenByStranger).jsonArray.size)
        assertFalse(seenByStranger.contains(saved.id), "nothing of the entry reaches somebody who is not a member")

        val single = client.get("/api/projects/$p") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}") }.bodyAsText()
        assertTrue(Json.parseToJsonElement(single).jsonObject["todayEntry"] is JsonNull)
    }
}
