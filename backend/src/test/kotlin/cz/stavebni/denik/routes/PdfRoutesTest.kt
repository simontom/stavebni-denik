package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class PdfRoutesTest : BaseIntegrationTest() {

    @Test
    fun `unauthenticated pdf request returns 401 Unauthorized`() = testApplication {
        application {
            module()
        }

        val response = client.get("/api/reports/${UUID.randomUUID()}/pdf")
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `authenticated user can download daily report pdf`() = testApplication {
        application {
            module()
        }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)

        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "PDF Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")

        val response = client.get("/api/reports/${report.id}/pdf") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val contentDisposition = response.headers[HttpHeaders.ContentDisposition]
        assertNotNull(contentDisposition)
        assertTrue(contentDisposition!!.contains("attachment"))
        assertTrue(contentDisposition.contains(".pdf"))

        val pdfBytes = response.bodyAsBytes()
        assertTrue(pdfBytes.isNotEmpty())
        assertTrue(pdfBytes.size > 10)
    }
}
