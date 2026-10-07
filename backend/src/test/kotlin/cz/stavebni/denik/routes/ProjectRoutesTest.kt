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

class ProjectRoutesTest : BaseIntegrationTest() {

    @Test
    fun `unauthenticated access to projects returns 401 Unauthorized`() = testApplication {
        application {
            module()
        }

        val response = client.get("/api/projects")
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `authenticated BOSS can create and list projects`() = testApplication {
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

        val projectReq = ProjectDto(
            id = "",
            name = "Ktor Route Project",
            address = "Karlova 15, Brno",
            cadastralArea = "Brno-Stred",
            parcelNumbers = "450/1",
            builder = "Mesto Brno",
            contractor = "Stavitel a.s.",
            siteManagerId = boss.id.toString()
        )

        // 1. POST /api/projects
        val postResponse = client.post("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(projectReq)
        }
        assertEquals(HttpStatusCode.OK, postResponse.status)
        val createdBody = postResponse.bodyAsText()
        assertTrue(createdBody.contains("Ktor Route Project"))

        // 2. GET /api/projects
        val getResponse = client.get("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertEquals(HttpStatusCode.OK, getResponse.status)
        val listBody = getResponse.bodyAsText()
        assertTrue(listBody.contains("Ktor Route Project"))
    }

    @Test
    fun `WORKER role cannot create project and receives 403 Forbidden`() = testApplication {
        application {
            module()
        }

        val client = createClient {
            install(ContentNegotiation) {
                json()
            }
        }

        val worker = createTestUser(role = Role.WORKER)
        val token = generateJwtToken(worker)

        val projectReq = ProjectDto(
            id = "",
            name = "Forbidden Project",
            address = "Address",
            cadastralArea = "Area",
            parcelNumbers = "1",
            builder = "Builder",
            contractor = "Contractor",
            siteManagerId = worker.id.toString()
        )

        val response = client.post("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(projectReq)
        }
        assertEquals(HttpStatusCode.Forbidden, response.status)
    }
}
