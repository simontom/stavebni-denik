package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.PdfExportException
import cz.stavebni.denik.services.PdfExportService
import cz.stavebni.denik.services.PdfUnavailableException
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.TypstCompiler
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** What a client sees when the PDF export works, and when it cannot. */
class PdfFailureRoutesTest : BaseIntegrationTest() {

    private suspend fun reportOf(boss: SessionUser): String {
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "PDF Failure Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        return DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28").id
    }

    @Test
    fun `a good export is a private PDF attachment`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val reportId = reportOf(boss)

        val response = client.get("/api/reports/$reportId/pdf") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}") }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(ContentType.Application.Pdf, response.contentType()?.withoutParameters())
        assertTrue(response.headers[HttpHeaders.ContentDisposition]!!.contains("report_$reportId.pdf"))
        assertEquals("private, no-store", response.headers[HttpHeaders.CacheControl])
    }

    @Test
    fun `without typst the export answers 503 with a readable error, not an empty PDF`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val reportId = reportOf(boss)
        PdfExportService.compiler = TypstCompiler { _, _, _ -> throw PdfUnavailableException("typst could not be started") }

        val response = client.get("/api/reports/$reportId/pdf") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}") }

        assertEquals(HttpStatusCode.ServiceUnavailable, response.status)
        assertNotEquals(ContentType.Application.Pdf, response.contentType()?.withoutParameters())
        assertTrue(response.bodyAsText().contains("není na serveru dostupný"), response.bodyAsText())
    }

    @Test
    fun `a failing typst answers 500 without leaking its output`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val reportId = reportOf(boss)
        PdfExportService.compiler = TypstCompiler { _, _, _ ->
            throw PdfExportException("typst failed (exit code 1): error in /tmp/denik-pdf-123/main.typ: secret project text")
        }

        val response = client.get("/api/reports/$reportId/pdf") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}") }

        assertEquals(HttpStatusCode.InternalServerError, response.status)
        val body = response.bodyAsText()
        assertFalse(body.contains("typst"), body)
        assertFalse(body.contains("/tmp"), body)
        assertFalse(body.contains("secret project text"), body)
    }
}
