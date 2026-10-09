package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.FakeTypst
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.REPORT_ACKNOWLEDGEMENTS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.AuditService
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.DashboardService
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

/** Several parties each take note of a signed entry: one record per person, written once, never changed. */
class AcknowledgementRoutesTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val tds: SessionUser, val author: SessionUser, val client: SessionUser, val projectId: UUID, val reportId: String)

    private suspend fun site(sign: Boolean = true): Site {
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val tds = createTestUser(nickname = "tds", displayName = "Ing. Technický Dozor", role = Role.INSPECTOR)
        val author = createTestUser(nickname = "author", displayName = "Ing. Autorský Dozor", role = Role.INSPECTOR)
        val client = createTestUser(nickname = "client", displayName = "Stavebník s.r.o.", role = Role.INVESTOR)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Site", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val projectId = UUID.fromString(project.id)
        listOf(tds, author, client).forEach { addMember(projectId, it) }
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28")
        if (sign) DailyReportService.signReport(boss, UUID.fromString(report.id))
        return Site(boss, tds, author, client, projectId, report.id)
    }

    private suspend fun ApplicationTestBuilder.acknowledge(user: SessionUser, reportId: String): HttpResponse =
        client.post("/api/reports/$reportId/acknowledge") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

    private suspend fun ApplicationTestBuilder.report(user: SessionUser, reportId: String) =
        Json.parseToJsonElement(client.get("/api/reports/$reportId") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }.bodyAsText()).jsonObject

    @Test
    fun `every party acknowledges once, and the entry lists all of them in order`() = testApplication {
        application { module() }
        val s = site()

        assertEquals(HttpStatusCode.OK, acknowledge(s.tds, s.reportId).status)
        assertEquals(HttpStatusCode.OK, acknowledge(s.client, s.reportId).status)
        assertEquals(HttpStatusCode.OK, acknowledge(s.author, s.reportId).status)

        val dto = report(s.boss, s.reportId)
        assertTrue(dto["isAcknowledged"]!!.jsonPrimitive.content.toBoolean())
        val list = dto["acknowledgements"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("Ing. Technický Dozor", "Stavebník s.r.o.", "Ing. Autorský Dozor"), list.map { it["name"]!!.jsonPrimitive.content })
        assertEquals(listOf("INSPECTOR", "INVESTOR", "INSPECTOR"), list.map { it["role"]!!.jsonPrimitive.content })
        assertTrue(list.all { it["at"]!!.jsonPrimitive.content.isNotBlank() })
    }

    @Test
    fun `the same person cannot acknowledge twice, and the first record stays`() = testApplication {
        application { module() }
        val s = site()
        assertEquals(HttpStatusCode.OK, acknowledge(s.tds, s.reportId).status)
        val first = dsl.select(REPORT_ACKNOWLEDGEMENTS.CREATEDAT).from(REPORT_ACKNOWLEDGEMENTS).fetchOne(REPORT_ACKNOWLEDGEMENTS.CREATEDAT)

        val again = acknowledge(s.tds, s.reportId)

        assertEquals(HttpStatusCode.Conflict, again.status, again.bodyAsText())
        assertEquals(1, dsl.fetchCount(REPORT_ACKNOWLEDGEMENTS))
        assertEquals(first, dsl.select(REPORT_ACKNOWLEDGEMENTS.CREATEDAT).from(REPORT_ACKNOWLEDGEMENTS).fetchOne(REPORT_ACKNOWLEDGEMENTS.CREATEDAT))
    }

    @Test
    fun `an unsigned entry cannot be acknowledged, and the manager, a worker and strangers cannot acknowledge`() = testApplication {
        application { module() }
        val signed = site()
        val unsigned = DailyReportService.createReport(signed.boss, signed.projectId, "2026-09-29")
        assertEquals(HttpStatusCode.Conflict, acknowledge(signed.tds, unsigned.id).status)

        val stranger = createTestUser(nickname = "stranger", role = Role.INSPECTOR)
        assertEquals(HttpStatusCode.Forbidden, acknowledge(signed.boss, signed.reportId).status)
        assertEquals(HttpStatusCode.Forbidden, acknowledge(stranger, signed.reportId).status)
        assertEquals(0, dsl.fetchCount(REPORT_ACKNOWLEDGEMENTS))
    }

    @Test
    fun `simultaneous acknowledgements by the same person end in exactly one`() = testApplication {
        application { module() }
        val s = site()

        val statuses = coroutineScope {
            (1..6).map { async(Dispatchers.IO) { acknowledge(s.tds, s.reportId).status } }.awaitAll()
        }

        assertEquals(1, statuses.count { it == HttpStatusCode.OK }, statuses.toString())
        assertEquals(5, statuses.count { it == HttpStatusCode.Conflict })
        assertEquals(1, dsl.fetchCount(REPORT_ACKNOWLEDGEMENTS))
    }

    @Test
    fun `an acknowledgement cannot be changed or deleted, and none can be added to an unsigned entry, even by SQL`() = testApplication {
        application { module() }
        val s = site()
        acknowledge(s.tds, s.reportId)

        assertTrue(runCatching { dsl.execute("update report_acknowledgements set \"userId\" = \"userId\"") }.isFailure, "update")
        assertTrue(runCatching { dsl.execute("delete from report_acknowledgements") }.isFailure, "delete")

        val unsigned = DailyReportService.createReport(s.boss, s.projectId, "2026-09-29")
        val insert = runCatching {
            dsl.execute("""insert into report_acknowledgements ("reportId", "userId", "role") values (?, ?, 'INSPECTOR')""", UUID.fromString(unsigned.id), s.tds.id)
        }
        assertTrue(insert.isFailure, "insert for an unsigned entry")
        assertEquals(1, dsl.fetchCount(REPORT_ACKNOWLEDGEMENTS))
    }

    @Test
    fun `acknowledgements are audited, and the signed entry stays immutable as a whole`() = testApplication {
        application { module() }
        val s = site()
        acknowledge(s.tds, s.reportId)
        acknowledge(s.client, s.reportId)

        assertEquals(2, dsl.fetchCount(cz.stavebni.denik.jooq.tables.references.AUDIT_LOG, cz.stavebni.denik.jooq.tables.references.AUDIT_LOG.ACTION.eq("report.acknowledge")))
        assertTrue(AuditService.verifyChain(dsl).ok)
        // The signed row itself cannot change in any column (no exception for the acknowledgement any more).
        assertTrue(runCatching { dsl.execute("""update daily_reports set "updatedAt" = now() where id = ?""", UUID.fromString(s.reportId)) }.isFailure)
    }

    @Test
    fun `the dashboard counts signed entries nobody has taken note of`() = testApplication {
        application { module() }
        val s = site()

        assertEquals(1, DashboardService.getDashboardStats(s.tds).pendingUnacknowledgedReports)
        acknowledge(s.client, s.reportId)
        assertEquals(0, DashboardService.getDashboardStats(s.tds).pendingUnacknowledgedReports, "somebody has: it is no longer pending")
    }

    @Test
    fun `the PDF lists who took note`() = testApplication {
        application { module() }
        val s = site()
        acknowledge(s.tds, s.reportId)
        acknowledge(s.client, s.reportId)
        var data = ""
        PdfExportService.compiler = TypstCompiler { workDir, typst, pdf ->
            data = File(workDir, "data.json").readText()
            FakeTypst.compile(workDir, typst, pdf)
        }

        val response = client.get("/api/reports/${s.reportId}/pdf") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(s.boss)}") }

        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue(data.contains("Ing. Technický Dozor (dozor)") && data.contains("Stavebník s.r.o. (stavebník)"), data)
    }
}
