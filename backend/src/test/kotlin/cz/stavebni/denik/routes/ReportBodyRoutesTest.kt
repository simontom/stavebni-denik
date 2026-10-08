package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
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
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** What the report endpoints do with bodies that are missing, broken, or only partly filled in. */
class ReportBodyRoutesTest : BaseIntegrationTest() {

    private suspend fun createProject(owner: SessionUser): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = "Body Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor",
                siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private fun addMember(projectId: UUID, user: SessionUser) {
        dsl.insertInto(PROJECT_MEMBERS).set(PROJECT_MEMBERS.PROJECTID, projectId).set(PROJECT_MEMBERS.USERID, user.id).execute()
    }

    private fun stored(projectId: UUID, date: String) =
        dsl.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.PROJECTID.eq(projectId).and(DAILY_REPORTS.DATE.eq(java.time.LocalDate.parse(date))))
            .fetchOne()

    private suspend fun ApplicationTestBuilder.post(token: String, path: String, body: String? = null): HttpResponse =
        client.post(path) {
            header(HttpHeaders.Authorization, "Bearer $token")
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }

    @Test
    fun `a request without a body cannot blank an existing report`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž stropu", isControlDay = true, constructionObj = "SO 01")
        val before = stored(projectId, "2026-09-28")!!

        val response = post(token, "/api/projects/$projectId/reports/2026-09-28")

        // No body and no Content-Type: the server refuses it as a client error (Ktor answers 415); what matters is that nothing changed.
        assertTrue(response.status.value in 400..499, "${response.status}: ${response.bodyAsText()}")
        val after = stored(projectId, "2026-09-28")!!
        assertEquals("Betonáž stropu", after.workdescription)
        assertEquals(before.updatedat, after.updatedat)
    }

    @Test
    fun `broken or mistyped JSON is a 400, not a 500 and not an empty report`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž stropu")

        for (body in listOf("{not json", "[1,2,3]", """{"isControlDay":"ano"}""", """{"workDescription":{"a":1}}""")) {
            val response = post(token, "/api/projects/$projectId/reports/2026-09-28", body)
            assertEquals(HttpStatusCode.BadRequest, response.status, "body '$body': ${response.bodyAsText()}")
        }
        assertEquals(HttpStatusCode.BadRequest, post(token, "/api/projects/$projectId/reports", "{not json").status)
        // An empty body is no content at all: refused as a client error as well (Ktor answers 415).
        assertTrue(post(token, "/api/projects/$projectId/reports/2026-09-28", "").status.value in 400..499)

        assertEquals("Betonáž stropu", stored(projectId, "2026-09-28")!!.workdescription)
    }

    @Test
    fun `saving only some fields keeps the others`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)
        DailyReportService.createReport(
            boss, projectId, "2026-09-28",
            workDescription = "Betonáž stropu", workersByTrade = """[{"trade":"Betonář","count":4}]""", isControlDay = true, constructionObj = "SO 01"
        )

        val response = post(token, "/api/projects/$projectId/reports/2026-09-28", """{"workDescription":"Betonáž stropu a schodiště"}""")

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val row = stored(projectId, "2026-09-28")!!
        assertEquals("Betonáž stropu a schodiště", row.workdescription)
        assertTrue(row.workersbytrade!!.data().contains("Betonář"))
        assertTrue(row.iscontrolday!!)
        assertEquals("SO 01", row.constructionobj)
    }

    @Test
    fun `saving a day that has no report yet creates it`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        val response = post(token, "/api/projects/$projectId/reports/2026-09-30", """{"workDescription":"Nový den"}""")

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertEquals("Nový den", stored(projectId, "2026-09-30")!!.workdescription)
    }

    @Test
    fun `creating the report of a day that already has one is a conflict, not an overwrite`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        val first = post(token, "/api/projects/$projectId/reports", """{"date":"2026-09-28","workDescription":"První"}""")
        val second = post(token, "/api/projects/$projectId/reports", """{"date":"2026-09-28","workDescription":"Druhý"}""")

        assertEquals(HttpStatusCode.Created, first.status, first.bodyAsText())
        assertEquals(HttpStatusCode.Conflict, second.status)
        assertEquals("První", stored(projectId, "2026-09-28")!!.workdescription)
    }

    @Test
    fun `two requests creating the same day at once give one 201 and one 409`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = createProject(boss)

        val statuses = coroutineScope {
            listOf("A", "B").map { text ->
                async { post(token, "/api/projects/$projectId/reports", """{"date":"2026-09-28","workDescription":"$text"}""").status }
            }.awaitAll()
        }

        assertEquals(setOf(HttpStatusCode.Created, HttpStatusCode.Conflict), statuses.toSet(), statuses.toString())
        assertEquals(1, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)))
    }

    @Test
    fun `a worker changes only their own reports, the site manager any`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER)
        val otherWorker = createTestUser(role = Role.WORKER)
        val projectId = createProject(boss)
        addMember(projectId, worker)
        addMember(projectId, otherWorker)
        DailyReportService.createReport(worker, projectId, "2026-09-28", workDescription = "Text pracovníka")

        val byOther = post(generateJwtToken(otherWorker), "/api/projects/$projectId/reports/2026-09-28", """{"workDescription":"Cizí zásah"}""")
        assertEquals(HttpStatusCode.Forbidden, byOther.status)
        assertEquals("Text pracovníka", stored(projectId, "2026-09-28")!!.workdescription)

        val byAuthor = post(generateJwtToken(worker), "/api/projects/$projectId/reports/2026-09-28", """{"workDescription":"Oprava autora"}""")
        assertEquals(HttpStatusCode.OK, byAuthor.status, byAuthor.bodyAsText())

        val byBoss = post(generateJwtToken(boss), "/api/projects/$projectId/reports/2026-09-28", """{"workDescription":"Oprava stavbyvedoucího"}""")
        assertEquals(HttpStatusCode.OK, byBoss.status, byBoss.bodyAsText())
        assertEquals("Oprava stavbyvedoucího", stored(projectId, "2026-09-28")!!.workdescription)
    }

    @Test
    fun `a refusal does not name the internal action`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER)
        val projectId = createProject(boss)
        addMember(projectId, worker)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28")

        val response = post(generateJwtToken(worker), "/api/reports/${report.id}/sign")

        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertFalse(response.bodyAsText().contains("ReportSign"), response.bodyAsText())
    }
}
