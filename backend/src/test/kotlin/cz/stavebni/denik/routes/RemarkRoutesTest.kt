package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.FakeTypst
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.REMARKS
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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.util.UUID

/**
 * Entries of other parties (supervision, the client, authorities): made also after the day's entry was signed,
 * in their own name or, for an outside party, recorded by the manager; never changed or deleted.
 */
class RemarkRoutesTest : BaseIntegrationTest() {

    private class Site(
        val boss: SessionUser, val worker: SessionUser, val inspector: SessionUser, val investor: SessionUser,
        val projectId: UUID, val reportId: String,
    )

    private suspend fun site(sign: Boolean = false): Site {
        val boss = createTestUser(nickname = "boss", displayName = "Jan Stavbyvedoucí", role = Role.BOSS)
        val worker = createTestUser(nickname = "worker", displayName = "Petr Dělník", role = Role.WORKER)
        val inspector = createTestUser(nickname = "tds", displayName = "Ing. Dozor", role = Role.INSPECTOR)
        val investor = createTestUser(nickname = "client", displayName = "Stavebník s.r.o.", role = Role.INVESTOR)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Site", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val projectId = UUID.fromString(project.id)
        listOf(worker, inspector, investor).forEach { addMember(projectId, it) }
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž")
        if (sign) DailyReportService.signReport(boss, UUID.fromString(report.id))
        return Site(boss, worker, inspector, investor, projectId, report.id)
    }

    private suspend fun ApplicationTestBuilder.post(user: SessionUser, reportId: String, body: String): HttpResponse =
        client.post("/api/reports/$reportId/remarks") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private suspend fun ApplicationTestBuilder.list(user: SessionUser, reportId: String): HttpResponse =
        client.get("/api/reports/$reportId/remarks") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }

    private fun body(text: String, externalAuthor: String? = null) =
        """{"text":${JsonPrimitive(text)}${externalAuthor?.let { ""","externalAuthor":${JsonPrimitive(it)}""" } ?: ""}}"""

    @Test
    fun `an inspector and an investor write in their own name, also after the entry was signed`() = testApplication {
        application { module() }
        val s = site(sign = true)

        val fromInspector = post(s.inspector, s.reportId, body("Kontrola výztuže provedena, bez závad."))
        val fromInvestor = post(s.investor, s.reportId, body("Požaduji doplnit fotodokumentaci."))

        assertEquals(HttpStatusCode.Created, fromInspector.status, fromInspector.bodyAsText())
        assertEquals(HttpStatusCode.Created, fromInvestor.status, fromInvestor.bodyAsText())
        val listed = Json.parseToJsonElement(list(s.boss, s.reportId).bodyAsText()).jsonArray.map { it.jsonObject }
        assertEquals(listOf("INSPECTOR_REMARK", "INVESTOR_NOTE"), listed.map { it["type"]!!.jsonPrimitive.content })
        assertEquals(listOf("Ing. Dozor", "Stavebník s.r.o."), listed.map { it["authorName"]!!.jsonPrimitive.content })
        assertTrue(listed.all { it["externalAuthor"] == null || it["externalAuthor"]!!.toString() == "null" })
    }

    @Test
    fun `an entry may also be made while the day's entry is still being written`() = testApplication {
        application { module() }
        val s = site(sign = false)

        assertEquals(HttpStatusCode.Created, post(s.inspector, s.reportId, body("Průběžná kontrola")).status)
    }

    @Test
    fun `the manager records an entry for an outside party and names it, and cannot write one without naming`() = testApplication {
        application { module() }
        val s = site(sign = true)

        val noName = post(s.boss, s.reportId, body("Kontrola provedena"))
        assertEquals(HttpStatusCode.BadRequest, noName.status, noName.bodyAsText())

        val recorded = post(s.boss, s.reportId, body("Při kontrole nebyly zjištěny nedostatky.", externalAuthor = "Stavební úřad Brno, Ing. Novák"))
        assertEquals(HttpStatusCode.Created, recorded.status, recorded.bodyAsText())
        val dto = Json.parseToJsonElement(recorded.bodyAsText()).jsonObject
        assertEquals("EXTERNAL_ENTRY", dto["type"]!!.jsonPrimitive.content)
        assertEquals("Stavební úřad Brno, Ing. Novák", dto["externalAuthor"]!!.jsonPrimitive.content)
        assertEquals("Jan Stavbyvedoucí", dto["authorName"]!!.jsonPrimitive.content, "who recorded it is kept")
        assertTrue(dsl.select(REMARKS.ISOFFICIAL).from(REMARKS).fetchOne(REMARKS.ISOFFICIAL)!!, "an outside party's entry is official")
    }

    @Test
    fun `an inspector or investor cannot write for somebody else`() = testApplication {
        application { module() }
        val s = site(sign = true)

        for (who in listOf(s.inspector, s.investor)) {
            val response = post(who, s.reportId, body("Text", externalAuthor = "Jiná osoba"))
            assertEquals(HttpStatusCode.BadRequest, response.status, who.nickname)
        }
        assertEquals(0, dsl.fetchCount(REMARKS))
    }

    @Test
    fun `workers, administrators who are not members and strangers may not write, but members may read`() = testApplication {
        application { module() }
        val s = site(sign = true)
        val admin = createTestUser(nickname = "admin", role = Role.BOSS, isAdmin = true)
        val stranger = createTestUser(nickname = "stranger", role = Role.INSPECTOR)

        for (who in listOf(s.worker, admin, stranger)) {
            assertEquals(HttpStatusCode.Forbidden, post(who, s.reportId, body("Nepovoleno")).status, who.nickname)
        }
        assertEquals(0, dsl.fetchCount(REMARKS))

        assertEquals(HttpStatusCode.OK, list(s.worker, s.reportId).status)
        assertEquals(HttpStatusCode.OK, list(admin, s.reportId).status)
        assertEquals(HttpStatusCode.Forbidden, list(stranger, s.reportId).status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/reports/${s.reportId}/remarks").status)
    }

    @Test
    fun `an entry cannot be changed or deleted, even by SQL`() = testApplication {
        application { module() }
        val s = site(sign = true)
        post(s.inspector, s.reportId, body("Původní zápis"))

        assertTrue(runCatching { dsl.execute("update remarks set text = 'Změněno'") }.isFailure, "update")
        assertTrue(runCatching { dsl.execute("delete from remarks") }.isFailure, "delete")
        assertTrue(runCatching { dsl.execute("update remarks set \"deletedAt\" = now()") }.isFailure, "soft delete")
        assertEquals("Původní zápis", dsl.select(REMARKS.TEXT).from(REMARKS).fetchOne(REMARKS.TEXT))
    }

    @Test
    fun `empty, too long and malformed entries are refused`() = testApplication {
        application { module() }
        val s = site(sign = true)

        for (b in listOf("""{"text":""}""", """{"text":"  "}""", "{}", "{nope", body("x".repeat(4001)), body("ok", externalAuthor = "a".repeat(201)))) {
            assertEquals(HttpStatusCode.BadRequest, post(s.inspector, s.reportId, b).status, b.take(40))
        }
        assertEquals(HttpStatusCode.Created, post(s.inspector, s.reportId, body("x".repeat(4000))).status)
    }

    @Test
    fun `an entry is audited with its whole text and who spoke for whom, and the chain verifies`() = testApplication {
        application { module() }
        val s = site(sign = true)
        post(s.boss, s.reportId, body("Kontrola BOZP bez závad", externalAuthor = "OIP, Ing. Svoboda"))

        val row = dsl.select(AUDIT_LOG.ACTION, AUDIT_LOG.ENTITY_ID, AUDIT_LOG.AFTER, AUDIT_LOG.ACTOR_ID)
            .from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.remark.add")).fetchOne()!!
        assertEquals(s.reportId, row.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(s.boss.id.toString(), row.get(AUDIT_LOG.ACTOR_ID))
        val after = row.get(AUDIT_LOG.AFTER)!!.data()
        assertTrue(after.contains("Kontrola BOZP bez závad") && after.contains("OIP, Ing. Svoboda") && after.contains("EXTERNAL_ENTRY"), after)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `entries do not change the signature of the signed entry`() = testApplication {
        application { module() }
        val s = site(sign = true)
        val before = dsl.fetchValue("""select "signatureHash" from daily_reports where id = ?""", UUID.fromString(s.reportId))

        post(s.inspector, s.reportId, body("Zápis dozoru"))

        assertEquals(before, dsl.fetchValue("""select "signatureHash" from daily_reports where id = ?""", UUID.fromString(s.reportId)))
        val check = client.get("/api/reports/${s.reportId}/signature") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(s.boss)}") }
        assertTrue(Json.parseToJsonElement(check.bodyAsText()).jsonObject["contentMatches"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `the PDF carries the entries of other parties with who wrote and for whom`() = testApplication {
        application { module() }
        val s = site(sign = true)
        post(s.inspector, s.reportId, body("Dozor: výztuž v pořádku"))
        post(s.boss, s.reportId, body("Úřad: bez závad", externalAuthor = "Stavební úřad"))
        var data = ""
        PdfExportService.compiler = TypstCompiler { workDir, typst, pdf ->
            data = File(workDir, "data.json").readText()
            FakeTypst.compile(workDir, typst, pdf)
        }

        val response = client.get("/api/reports/${s.reportId}/pdf") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(s.boss)}") }

        assertEquals(HttpStatusCode.OK, response.status)
        for (expected in listOf("Dozor: výztuž v pořádku", "Ing. Dozor", "Úřad: bez závad", "Stavební úřad")) assertTrue(data.contains(expected), expected)
    }
}
