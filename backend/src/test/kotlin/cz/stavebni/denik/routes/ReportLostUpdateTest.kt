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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** Lost updates the reviewers found: a second creator, signing a version nobody looked at, and invented worker data. */
class ReportLostUpdateTest : BaseIntegrationTest() {

    private suspend fun createProject(owner: SessionUser): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = "Lost Update Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private fun stored(projectId: UUID) = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.PROJECTID.eq(projectId)).fetchOne()

    private suspend fun ApplicationTestBuilder.save(token: String, projectId: UUID, body: String, date: String = "2026-09-28"): HttpResponse =
        client.post("/api/projects/$projectId/reports/$date") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private suspend fun ApplicationTestBuilder.postJson(token: String, path: String, body: String? = null): HttpResponse =
        client.post(path) {
            header(HttpHeaders.Authorization, "Bearer $token")
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }

    // --- the second creator ---------------------------------------------------------------------

    @Test
    fun `the second person who creates the same day is told, and the first entry survives`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        // Both opened an empty day. A saves first.
        val a = save(token, projectId, """{"workDescription":"Verze A","expectNew":true}""")
        assertEquals(HttpStatusCode.OK, a.status, a.bodyAsText())
        // B still believes the day is empty.
        val b = save(token, projectId, """{"workDescription":"Verze B","expectNew":true}""")

        assertEquals(HttpStatusCode.Conflict, b.status)
        assertTrue(b.bodyAsText().contains("\"code\":\"STALE_VERSION\""), b.bodyAsText())
        assertEquals("Verze A", stored(projectId)!!.workdescription)
    }

    @Test
    fun `expecting a new day when it really is new just creates it`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        val response = save(token, projectId, """{"workDescription":"První","expectNew":true}""")

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertEquals("První", stored(projectId)!!.workdescription)
    }

    // --- signing a version ----------------------------------------------------------------------

    @Test
    fun `signing names the version, and a stale version is refused without signing`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Verze 1")
        val seenByTheSigner = created.updatedAt!!
        // Somebody else changes the entry after the signer loaded it.
        save(token, projectId, """{"workDescription":"Verze 2"}""")

        val stale = postJson(token, "/api/projects/$projectId/reports/2026-09-28/sign", """{"expectedUpdatedAt":"$seenByTheSigner"}""")
        val staleById = postJson(token, "/api/reports/${created.id}/sign", """{"expectedUpdatedAt":"$seenByTheSigner"}""")

        assertEquals(HttpStatusCode.Conflict, stale.status)
        assertEquals(HttpStatusCode.Conflict, staleById.status)
        assertTrue(stale.bodyAsText().contains("STALE_VERSION"), stale.bodyAsText())
        assertNull(stored(projectId)!!.lockedat, "nothing was signed")

        val current = stored(projectId)!!.updatedat.toString()
        val signed = postJson(token, "/api/projects/$projectId/reports/2026-09-28/sign", """{"expectedUpdatedAt":"$current"}""")
        assertEquals(HttpStatusCode.OK, signed.status, signed.bodyAsText())
        assertNotNull(stored(projectId)!!.lockedat)
    }

    @Test
    fun `signing without a version still works, and a broken body is a 400`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        val first = DailyReportService.createReport(boss, projectId, "2026-09-28")
        val second = DailyReportService.createReport(boss, projectId, "2026-09-29")

        assertEquals(HttpStatusCode.BadRequest, postJson(token, "/api/reports/${second.id}/sign", "{not json").status)
        assertEquals(HttpStatusCode.BadRequest, postJson(token, "/api/reports/${second.id}/sign", """{"expectedUpdatedAt":"yesterday"}""").status)
        assertNull(dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(second.id))).fetchOne()!!.lockedat)

        // An empty body (what older clients send) and the body the SPA always sent ({"signed":true}) are fine.
        assertEquals(HttpStatusCode.OK, postJson(token, "/api/reports/${first.id}/sign").status)
        assertEquals(HttpStatusCode.OK, postJson(token, "/api/reports/${second.id}/sign", """{"signed":true}""").status)
    }

    // --- worker data is never invented or dropped -----------------------------------------------

    @Test
    fun `a trade without a head count is refused instead of getting an invented 1`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        for (body in listOf(
            """{"workerTrade":"Zedník","workerCount":""}""",
            """{"workerTrade":"Zedník"}""",
            """{"workerTrade":"Zedník","workerCount":"dva"}""",
            """{"workerTrade":"Zedník","workerCount":"2.5"}""",
            """{"workerTrade":"Zedník","workerCount":"-1"}""",
        )) {
            val response = save(token, projectId, body)
            assertEquals(HttpStatusCode.BadRequest, response.status, "$body: ${response.bodyAsText()}")
        }
        assertNull(stored(projectId), "nothing was created")
    }

    @Test
    fun `a head count of zero is a real value`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        val response = save(token, projectId, """{"workDescription":"Stavba stála","workerTrade":"Zedník","workerCount":"0"}""")

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val rows = Json.parseToJsonElement(stored(projectId)!!.workersbytrade!!.data()).jsonArray
        assertEquals(1, rows.size)
        assertEquals(0, rows[0].jsonObject["count"]!!.jsonPrimitive.int)
    }

    @Test
    fun `a workers list keeps every trade, trims names, and refuses malformed lists`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        val ok = save(token, projectId, """{"workDescription":"X","workersByTrade":"[{\"trade\":\" Zedník \",\"count\":3},{\"trade\":\"Tesař\",\"count\":1}]"}""")
        assertEquals(HttpStatusCode.OK, ok.status, ok.bodyAsText())
        val workers = stored(projectId)!!.workersbytrade!!.data()
        val trades = Json.parseToJsonElement(workers).jsonArray.map { it.jsonObject["trade"]!!.jsonPrimitive.content }
        assertEquals(listOf("Zedník", "Tesař"), trades, "every trade is kept and the name is trimmed")

        val tooMany = (1..51).joinToString(",") { """{\"trade\":\"T$it\",\"count\":1}""" }
        for (bad in listOf(
            """[{\"trade\":\"\",\"count\":1}]""",
            """[{\"trade\":\"A\",\"count\":-1}]""",
            """[{\"trade\":\"A\",\"count\":1.5}]""",
            """[{\"trade\":\"A\"}]""",
            """{\"a\":1}""",
            """[$tooMany]""",
        )) {
            val response = save(token, projectId, """{"workersByTrade":"$bad"}""")
            assertEquals(HttpStatusCode.BadRequest, response.status, "$bad: ${response.bodyAsText()}")
        }
        assertEquals(workers, stored(projectId)!!.workersbytrade!!.data(), "refused lists changed nothing")
    }
}
