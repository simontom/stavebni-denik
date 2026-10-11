package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.FakeTypst
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.ADDENDA
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.module
import cz.stavebni.denik.services.AuditService
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.PdfExportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.TypstCompiler
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.util.UUID

/** Addenda: how a signed daily entry is corrected or completed. Append-only, signed entries only, members who write only. */
class AddendumRoutesTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val projectId: UUID, val reportId: String)

    private suspend fun site(sign: Boolean = true): Site {
        val boss = createTestUser(nickname = "boss", displayName = "Jan Stavbyvedoucí", role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Site", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val projectId = UUID.fromString(project.id)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž")
        if (sign) DailyReportService.signReport(boss, UUID.fromString(report.id))
        return Site(boss, projectId, report.id)
    }

    private suspend fun ApplicationTestBuilder.post(user: SessionUser, reportId: String, body: String): HttpResponse =
        client.post("/api/reports/$reportId/addenda") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private suspend fun ApplicationTestBuilder.list(user: SessionUser, reportId: String): HttpResponse =
        client.get("/api/reports/$reportId/addenda") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }

    private fun text(t: String) = """{"text":${kotlinx.serialization.json.JsonPrimitive(t)}}"""

    @Test
    fun `an addendum is added to a signed entry and listed with its author and time`() = testApplication {
        application { module() }
        val s = site()

        val created = post(s.boss, s.reportId, text("Oprava: betonáž proběhla ve 14 hodin, ne v 11."))
        assertEquals(HttpStatusCode.Created, created.status, created.bodyAsText())
        val dto = Json.parseToJsonElement(created.bodyAsText()).jsonObject
        assertEquals("Jan Stavbyvedoucí", dto["authorName"]!!.jsonPrimitive.content)

        post(s.boss, s.reportId, text("Doplněno: přítomen byl i statik."))
        val listed = Json.parseToJsonElement(list(s.boss, s.reportId).bodyAsText()).jsonArray
        assertEquals(listOf("Oprava: betonáž proběhla ve 14 hodin, ne v 11.", "Doplněno: přítomen byl i statik."), listed.map { it.jsonObject["text"]!!.jsonPrimitive.content }, "oldest first")
        assertTrue(listed.all { it.jsonObject["createdAt"]!!.jsonPrimitive.content.isNotBlank() })
    }

    @Test
    fun `an entry that is not signed takes no addendum, it is edited directly`() = testApplication {
        application { module() }
        val s = site(sign = false)

        val response = post(s.boss, s.reportId, text("Text"))

        assertEquals(HttpStatusCode.Conflict, response.status, response.bodyAsText())
        assertEquals(0, dsl.fetchCount(ADDENDA))
    }

    @Test
    fun `only members who write may add one, administrators who are not members and strangers may not`() = testApplication {
        application { module() }
        val s = site()
        val worker = createTestUser(nickname = "worker", role = Role.WORKER).also { addMember(s.projectId, it) }
        val inspector = createTestUser(nickname = "inspector", role = Role.INSPECTOR).also { addMember(s.projectId, it) }
        val investor = createTestUser(nickname = "investor", role = Role.INVESTOR).also { addMember(s.projectId, it) }
        val admin = createTestUser(nickname = "admin", role = Role.BOSS, isAdmin = true)
        val stranger = createTestUser(nickname = "stranger", role = Role.BOSS)

        assertEquals(HttpStatusCode.Created, post(worker, s.reportId, text("Od dělníka")).status)
        for (who in listOf(inspector, investor, admin, stranger)) {
            assertEquals(HttpStatusCode.Forbidden, post(who, s.reportId, text("Nepovoleno")).status, who.nickname)
        }
        assertEquals(1, dsl.fetchCount(ADDENDA))

        // They may read: members and administrators; a stranger may not.
        assertEquals(HttpStatusCode.OK, list(inspector, s.reportId).status)
        assertEquals(HttpStatusCode.OK, list(admin, s.reportId).status)
        assertEquals(HttpStatusCode.Forbidden, list(stranger, s.reportId).status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/reports/${s.reportId}/addenda").status)
    }

    @Test
    fun `an empty or too long text and a broken body are refused`() = testApplication {
        application { module() }
        val s = site()

        for (body in listOf("""{"text":""}""", """{"text":"   "}""", "{}", "{not json", text("x".repeat(4001)))) {
            assertEquals(HttpStatusCode.BadRequest, post(s.boss, s.reportId, body).status, body.take(40))
        }
        assertEquals(HttpStatusCode.Created, post(s.boss, s.reportId, text("x".repeat(4000))).status, "4000 characters are allowed")
        assertEquals(1, dsl.fetchCount(ADDENDA))
    }

    @Test
    fun `an addendum cannot be changed or deleted, not even by SQL, and none can be added to an unsigned entry by SQL`() = testApplication {
        application { module() }
        val s = site()
        post(s.boss, s.reportId, text("Původní dodatek"))

        val update = runCatching { dsl.execute("update addenda set text = 'Změněno'") }
        val delete = runCatching { dsl.execute("delete from addenda") }
        assertTrue(update.isFailure, "update")
        assertTrue(delete.isFailure, "delete")
        assertEquals("Původní dodatek", dsl.select(ADDENDA.TEXT).from(ADDENDA).fetchOne(ADDENDA.TEXT))

        // A second, unsigned entry: the database refuses an addendum there even when the application is bypassed.
        val unsigned = DailyReportService.createReport(s.boss, s.projectId, "2026-09-29")
        val insert = runCatching {
            dsl.execute("""insert into addenda ("reportId", "authorId", text) values (?, ?, 'x')""", UUID.fromString(unsigned.id), s.boss.id)
        }
        assertTrue(insert.isFailure, "insert into an unsigned entry")
    }

    @Test
    fun `an addendum is in the audit log with its whole text, and the chain still verifies`() = testApplication {
        application { module() }
        val s = site()
        post(s.boss, s.reportId, text("Oprava údaje o počasí"))

        val row = dsl.select(AUDIT_LOG.ACTION, AUDIT_LOG.ENTITY_ID, AUDIT_LOG.AFTER, AUDIT_LOG.ACTOR_ID)
            .from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.addendum.add")).fetchOne()!!
        assertEquals(s.reportId, row.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(s.boss.id.toString(), row.get(AUDIT_LOG.ACTOR_ID))
        assertTrue(row.get(AUDIT_LOG.AFTER)!!.data().contains("Oprava údaje o počasí"))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `addenda of one entry do not appear on another`() = testApplication {
        application { module() }
        val s = site()
        val second = DailyReportService.createReport(s.boss, s.projectId, "2026-09-29")
        DailyReportService.signReport(s.boss, UUID.fromString(second.id))
        post(s.boss, s.reportId, text("K prvnímu"))
        post(s.boss, second.id, text("Ke druhému"))

        val first = Json.parseToJsonElement(list(s.boss, s.reportId).bodyAsText()).jsonArray
        assertEquals(listOf("K prvnímu"), first.map { it.jsonObject["text"]!!.jsonPrimitive.content })
    }

    @Test
    fun `addenda added at the same moment are all stored`() = testApplication {
        application { module() }
        val s = site()

        val statuses = coroutineScope {
            (1..12).map { i -> async(Dispatchers.IO) { post(s.boss, s.reportId, text("Dodatek $i")).status } }.awaitAll()
        }

        assertTrue(statuses.all { it == HttpStatusCode.Created }, statuses.toString())
        assertEquals(12, dsl.fetchCount(ADDENDA))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `the PDF of a signed entry carries its addenda`() = testApplication {
        application { module() }
        val s = site()
        post(s.boss, s.reportId, text("Oprava: počet pracovníků byl 5."))
        var data = ""
        PdfExportService.compiler = TypstCompiler { workDir, typst, pdf ->
            data = File(workDir, "data.json").readText()
            FakeTypst.compile(workDir, typst, pdf)
        }

        val response = client.get("/api/reports/${s.reportId}/pdf") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(s.boss)}") }

        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue(data.contains("Oprava: počet pracovníků byl 5."), data)
        assertTrue(data.contains("Jan Stavbyvedoucí"), data)
    }
}
