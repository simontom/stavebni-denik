package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** Two people editing the same entry: the one who saves second is told, instead of silently overwriting. */
class ReportConcurrencyTest : BaseIntegrationTest() {

    private suspend fun createProject(owner: SessionUser): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = "Concurrency Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor",
                siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private fun stored(projectId: UUID) =
        dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.PROJECTID.eq(projectId)).fetchOne()!!

    private suspend fun ApplicationTestBuilder.save(token: String, projectId: UUID, body: String, date: String = "2026-09-28"): HttpResponse =
        client.post("/api/projects/$projectId/reports/$date") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private fun updatedAtOf(response: HttpResponse, body: String): String =
        Json.parseToJsonElement(body).jsonObject["updatedAt"]!!.jsonPrimitive.content

    @Test
    fun `reading and saving an entry returns its version`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "První")

        val read = client.get("/api/projects/$projectId/reports/2026-09-28") { header(HttpHeaders.Authorization, "Bearer $token") }
        val version = updatedAtOf(read, read.bodyAsText())
        assertEquals(created.updatedAt, version)

        val saved = save(token, projectId, """{"workDescription":"Druhá","expectedUpdatedAt":"$version"}""")
        assertEquals(HttpStatusCode.OK, saved.status, saved.bodyAsText())
        val newVersion = updatedAtOf(saved, saved.bodyAsText())
        assertNotEquals(version, newVersion, "a save gives the entry a new version")
        assertEquals("Druhá", stored(projectId).workdescription)
    }

    @Test
    fun `the editor who saves second is refused and the first one's text survives`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Původní")
        val seenByBoth = created.updatedAt!!

        // Both open the entry (same version). A saves first.
        val a = save(token, projectId, """{"workDescription":"Verze A","expectedUpdatedAt":"$seenByBoth"}""")
        assertEquals(HttpStatusCode.OK, a.status, a.bodyAsText())

        // B still holds the old version: the save is refused, nothing is overwritten.
        val b = save(token, projectId, """{"workDescription":"Verze B","expectedUpdatedAt":"$seenByBoth"}""")
        assertEquals(HttpStatusCode.Conflict, b.status)
        assertTrue(b.bodyAsText().contains("změnil někdo jiný"), b.bodyAsText())
        assertTrue(b.bodyAsText().contains("\"code\":\"STALE_VERSION\""), "the client can tell this conflict from others: ${b.bodyAsText()}")
        assertEquals("Verze A", stored(projectId).workdescription)

        // After reloading (taking over A's version) B can save.
        val reloaded = updatedAtOf(a, a.bodyAsText())
        val b2 = save(token, projectId, """{"workDescription":"Verze B po načtení","expectedUpdatedAt":"$reloaded"}""")
        assertEquals(HttpStatusCode.OK, b2.status, b2.bodyAsText())
        assertEquals("Verze B po načtení", stored(projectId).workdescription)
    }

    @Test
    fun `a save without the version still works (last one wins)`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Původní")

        val response = save(token, projectId, """{"workDescription":"Bez verze"}""")

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertEquals("Bez verze", stored(projectId).workdescription)
    }

    @Test
    fun `expecting a version for a day that has no entry is a conflict`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        val response = save(token, projectId, """{"workDescription":"Nic tu není","expectedUpdatedAt":"2026-09-28T10:00:00Z"}""")

        assertEquals(HttpStatusCode.Conflict, response.status)
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)))
    }

    @Test
    fun `a malformed version is a 400`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Původní")

        val response = save(token, projectId, """{"workDescription":"X","expectedUpdatedAt":"yesterday"}""")

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("Původní", stored(projectId).workdescription)
    }

    @Test
    fun `two saves at the same moment from the same version give one 200 and one 409`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        val version = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Původní").updatedAt!!

        val statuses = coroutineScope {
            listOf("A", "B").map { text ->
                async { save(token, projectId, """{"workDescription":"$text","expectedUpdatedAt":"$version"}""").status }
            }.awaitAll()
        }

        assertEquals(setOf(HttpStatusCode.OK, HttpStatusCode.Conflict), statuses.toSet(), statuses.toString())
        assertTrue(stored(projectId).workdescription in setOf("A", "B"))
    }

    @Test
    fun `a signed entry is still refused whatever version is sent`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Podepsaný")
        DailyReportService.lockReport(boss, UUID.fromString(created.id))
        val current = stored(projectId).updatedat.toString()

        val response = save(token, projectId, """{"workDescription":"Přepis","expectedUpdatedAt":"$current"}""")

        assertEquals(HttpStatusCode.Conflict, response.status)
        assertFalse(response.bodyAsText().contains("STALE_VERSION"), "a signed entry is not a 'reload and retry' case")
        assertEquals("Podepsaný", stored(projectId).workdescription)
    }
}
