package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.UUID
import javax.imageio.ImageIO

class PhotoRoutesTest : BaseIntegrationTest() {

    private fun createTestImageBytes(width: Int = 200, height: Int = 150): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val graphics = image.createGraphics()
        graphics.color = java.awt.Color.BLUE
        graphics.fillRect(0, 0, width, height)
        graphics.dispose()

        val baos = ByteArrayOutputStream()
        ImageIO.write(image, "png", baos)
        return baos.toByteArray()
    }

    @Test
    fun `unauthenticated photo upload returns 401 Unauthorized`() = testApplication {
        application {
            module()
        }

        val response = client.post("/api/photos/upload")
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `authenticated user can upload photo and retrieve it`() = testApplication {
        application {
            module()
        }

        val client = createClient {
            install(ContentNegotiation) {
                json()
            }
        }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)

        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "",
                name = "Photo Route Project",
                address = "Adresa",
                cadastralArea = "Area",
                parcelNumbers = "1",
                builder = "Builder",
                contractor = "Contractor",
                siteManagerId = boss.id.toString()
            )
        )
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-29")
        val imageBytes = createTestImageBytes(400, 300)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", report.id)
                append("photo", imageBytes, Headers.build {
                    append(HttpHeaders.ContentType, "image/png")
                    append(HttpHeaders.ContentDisposition, "filename=\"test_site.png\"")
                })
            }
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("\"status\":\"ok\""))
        assertTrue(body.contains("\"url\":\"/api/photos/"))
    }
}
