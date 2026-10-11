package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.FakeTypst
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.module
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
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Which entry a PDF is made from (never one of another project), and what happens when the export is busy. */
class PdfScopeRoutesTest : BaseIntegrationTest() {

    @AfterEach
    fun restoreDefaults() {
        PdfExportService.queueWait = Duration.ofSeconds(10)
    }

    private suspend fun project(owner: SessionUser, name: String): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = name, address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private suspend fun ApplicationTestBuilder.get(path: String, user: SessionUser): HttpResponse =
        client.get(path) { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }

    /** Remembers the project name of every document that is rendered. */
    private class Recording : TypstCompiler {
        val projectNames = mutableListOf<String>()
        override fun compile(workDir: File, typstFile: File, pdfFile: File) {
            val data = File(workDir, "data.json").readText()
            projectNames += Regex("\"projectName\":\\s*\"([^\"]*)\"").find(data)?.groupValues?.get(1) ?: "?"
            FakeTypst.compile(workDir, typstFile, pdfFile)
        }
    }

    @Test
    fun `a bare date cannot name a report without its project`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss, "A")
        DailyReportService.createReport(boss, p, "2026-09-28")

        val response = get("/api/reports/2026-09-28/pdf", boss)

        assertEquals(HttpStatusCode.BadRequest, response.status, response.bodyAsText())
    }

    @Test
    fun `by project and day the entry of that project is exported, not the same day of another project`() = testApplication {
        application { module() }
        val recording = Recording().also { PdfExportService.compiler = it }
        val boss = createTestUser(role = Role.BOSS)
        val first = project(boss, "First site")
        val second = project(boss, "Second site")
        DailyReportService.createReport(boss, first, "2026-09-28")
        DailyReportService.createReport(boss, second, "2026-09-28") // later, same day

        val response = get("/api/projects/$first/reports/2026-09-28/pdf", boss)

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(ContentType.Application.Pdf, response.contentType()?.withoutParameters())
        assertEquals(listOf("First site"), recording.projectNames)
    }

    @Test
    fun `an entry of another project is not found through this project`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val mine = project(boss, "Mine")
        val other = project(boss, "Other")
        val otherReport = DailyReportService.createReport(boss, other, "2026-09-28")

        assertEquals(HttpStatusCode.NotFound, get("/api/projects/$mine/reports/${otherReport.id}/pdf", boss).status)
        assertEquals(HttpStatusCode.NotFound, get("/api/projects/$mine/reports/2026-09-28/pdf", boss).status, "no entry that day in this project")
    }

    @Test
    fun `a non-member is refused by both routes and learns nothing`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val stranger = createTestUser(role = Role.BOSS)
        val p = project(boss, "Private site")
        project(stranger, "Their own")
        val report = DailyReportService.createReport(boss, p, "2026-09-28")

        assertEquals(HttpStatusCode.Forbidden, get("/api/reports/${report.id}/pdf", stranger).status)
        assertEquals(HttpStatusCode.Forbidden, get("/api/projects/$p/reports/${report.id}/pdf", stranger).status)
        assertEquals(HttpStatusCode.Forbidden, get("/api/projects/$p/reports/2026-09-28/pdf", stranger).status)
    }

    @Test
    fun `an administrator who is not a member may read the PDF`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val admin = createTestUser(role = Role.WORKER, isAdmin = true)
        val p = project(boss, "Site")
        val report = DailyReportService.createReport(boss, p, "2026-09-28")

        assertEquals(HttpStatusCode.OK, get("/api/reports/${report.id}/pdf", admin).status)
        assertEquals(HttpStatusCode.OK, get("/api/projects/$p/reports/2026-09-28/pdf", admin).status)
    }

    @Test
    fun `an unknown report is 404 on both routes`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss, "Site")

        assertEquals(HttpStatusCode.NotFound, get("/api/reports/${UUID.randomUUID()}/pdf", boss).status)
        assertEquals(HttpStatusCode.NotFound, get("/api/projects/$p/reports/${UUID.randomUUID()}/pdf", boss).status)
        assertEquals(HttpStatusCode.BadRequest, get("/api/projects/$p/reports/not-a-date/pdf", boss).status)
    }

    @Test
    fun `when both slots stay busy a further export is refused with 503 and a wait, not queued without end`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss, "Site")
        val reports = listOf("2026-09-26", "2026-09-27", "2026-09-28").map { DailyReportService.createReport(boss, p, it) }

        val release = CountDownLatch(1)
        val started = CountDownLatch(2)
        val rendered = AtomicInteger()
        PdfExportService.compiler = TypstCompiler { workDir, typst, pdf ->
            started.countDown()
            release.await(30, TimeUnit.SECONDS)
            rendered.incrementAndGet()
            FakeTypst.compile(workDir, typst, pdf)
        }
        PdfExportService.queueWait = Duration.ofMillis(400)

        coroutineScope {
            // Two exports take the two slots and hold them.
            val holders = reports.take(2).map { r -> async(Dispatchers.IO) { get("/api/reports/${r.id}/pdf", boss) } }
            assertTrue(started.await(20, TimeUnit.SECONDS), "both renders started")

            val refused = get("/api/reports/${reports[2].id}/pdf", boss)

            assertEquals(HttpStatusCode.ServiceUnavailable, refused.status, refused.bodyAsText())
            assertNotNull(refused.headers[HttpHeaders.RetryAfter], "it says when to come back")
            assertTrue(refused.bodyAsText().contains("PDF_BUSY"), refused.bodyAsText())

            release.countDown()
            assertEquals(listOf(HttpStatusCode.OK, HttpStatusCode.OK), holders.awaitAll().map { it.status })
        }
        assertEquals(2, rendered.get(), "the refused request never rendered anything")

        // The slots are free again afterwards (a refused request must not leak one).
        PdfExportService.compiler = FakeTypst
        val again = (1..4).map { get("/api/reports/${reports[2].id}/pdf", boss).status }
        assertEquals(List(4) { HttpStatusCode.OK }, again)
    }
}
