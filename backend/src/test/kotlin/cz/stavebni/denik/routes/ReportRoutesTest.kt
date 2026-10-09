package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.module
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class ReportRoutesTest : BaseIntegrationTest() {

    @Test
    fun `unauthenticated access to reports returns 401 Unauthorized`() = testApplication {
        application {
            module()
        }

        val response = client.get("/api/projects/${UUID.randomUUID()}/reports")
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `authenticated BOSS can create, list, and sign report`() = testApplication {
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
                name = "Report Test Project",
                address = "Adresa",
                cadastralArea = "Area",
                parcelNumbers = "1",
                builder = "Builder",
                contractor = "Contractor",
                siteManagerId = boss.id.toString()
            )
        )

        // 1. POST /api/projects/{projectId}/reports
        val postResponse = client.post("/api/projects/${project.id}/reports") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(
                CreateReportPayload(
                    date = "2026-09-29",
                    workDescription = "Montáž konstrukce",
                    workerTrade = "Tesař",
                    workerCount = "3",
                    isControlDay = true,
                    constructionObj = "SO-01"
                )
            )
        }
        assertEquals(HttpStatusCode.Created, postResponse.status)
        val postBody = postResponse.bodyAsText()
        assertTrue(postBody.contains("Montáž konstrukce"))
        assertTrue(postBody.contains("SO-01"))

        // 2. GET /api/projects/{projectId}/reports
        val listResponse = client.get("/api/projects/${project.id}/reports") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertEquals(HttpStatusCode.OK, listResponse.status)
        val listBody = listResponse.bodyAsText()
        assertTrue(listBody.contains("Montáž konstrukce"))

        // 3. GET /api/projects/{projectId}/reports/{date}
        val getResponse = client.get("/api/projects/${project.id}/reports/2026-09-29") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertEquals(HttpStatusCode.OK, getResponse.status)
        val getBody = getResponse.bodyAsText()
        assertTrue(getBody.contains("Montáž konstrukce"))

        // 4. POST /api/projects/{projectId}/reports/2026-09-29/sign
        val signResponse = client.post("/api/projects/${project.id}/reports/2026-09-29/sign") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody("""{"signed":true,"password":"Password123!"}""")
        }
        assertEquals(HttpStatusCode.OK, signResponse.status)

        // 5. Verify report is now locked
        val lockedResponse = client.get("/api/projects/${project.id}/reports/2026-09-29") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        val lockedBody = lockedResponse.bodyAsText()
        assertTrue(lockedBody.contains("\"isLocked\":true") || lockedBody.contains("\"isSigned\":true"))
    }
}
