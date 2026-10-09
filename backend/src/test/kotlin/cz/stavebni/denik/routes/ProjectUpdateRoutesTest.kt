package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** Changing the identification of a project through the HTTP API. */
class ProjectUpdateRoutesTest : BaseIntegrationTest() {

    private suspend fun newProject(manager: cz.stavebni.denik.domain.SessionUser): ProjectDto =
        ProjectService.createProject(
            manager,
            ProjectDto(
                id = "", name = "Dům", address = "Karlova 15", cadastralArea = "Brno", parcelNumbers = "1",
                builder = "Město", contractor = "Stavitel", siteManagerId = manager.id.toString(),
            )
        )

    private suspend fun ApplicationTestBuilder.put(token: String, projectId: String, body: String): HttpResponse =
        client.put("/api/projects/$projectId") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private fun body(created: ProjectDto, extra: String = "", updatedAt: String? = created.updatedAt, name: String = "Dům") =
        """{"name":"$name","address":"Karlova 15","cadastralArea":"Brno","parcelNumbers":"1","builder":"Město","contractor":"Stavitel","siteManagerId":"${created.siteManagerId}"${if (updatedAt != null) ""","updatedAt":"$updatedAt"""" else ""}$extra}"""

    @Test
    fun `the manager saves the identification and reads it back`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val created = newProject(boss)

        val response = put(token, created.id, body(created, ""","permitNumber":"SZ/1","permitDate":"2026-03-01","subcontractors":"Elektro s.r.o.","supportingDocuments":"Smlouva""""))
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())

        val read = client.get("/api/projects/${created.id}") { header(HttpHeaders.Authorization, "Bearer $token") }
        val json = Json.parseToJsonElement(read.bodyAsText()).jsonObject
        assertEquals("SZ/1", json["permitNumber"]!!.jsonPrimitive.content)
        assertEquals("2026-03-01", json["permitDate"]!!.jsonPrimitive.content)
        assertEquals("Elektro s.r.o.", json["subcontractors"]!!.jsonPrimitive.content)
        assertEquals("Smlouva", json["supportingDocuments"]!!.jsonPrimitive.content)
        assertEquals("BOSS", json["myRole"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a member who is not the manager gets 403 and the project is unchanged`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER)
        val created = newProject(boss)
        addMember(UUID.fromString(created.id), worker, Role.WORKER)

        val response = put(generateJwtToken(worker), created.id, body(created, name = "Cizí"))

        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertEquals("Dům", dsl.select(PROJECTS.NAME).from(PROJECTS).fetchSingle(PROJECTS.NAME))
    }

    @Test
    fun `without a session it is 401`() = testApplication {
        application { module() }
        val created = newProject(createTestUser(role = Role.BOSS))

        val response = client.put("/api/projects/${created.id}") {
            contentType(ContentType.Application.Json)
            setBody(body(created))
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `a bad body is 400, a missing required field is 400, a stale version is 409 with its code`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val created = newProject(boss)

        assertEquals(HttpStatusCode.BadRequest, put(token, created.id, "not json").status)
        assertEquals(HttpStatusCode.BadRequest, put(token, created.id, body(created, name = " ")).status)
        assertEquals(HttpStatusCode.BadRequest, put(token, created.id, body(created, ""","permitDate":"zítra"""")).status)

        assertEquals(HttpStatusCode.OK, put(token, created.id, body(created, name = "První")).status)
        val stale = put(token, created.id, body(created, name = "Druhý"))
        assertEquals(HttpStatusCode.Conflict, stale.status)
        assertEquals("STALE_VERSION", Json.parseToJsonElement(stale.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
        assertEquals("První", dsl.select(PROJECTS.NAME).from(PROJECTS).fetchSingle(PROJECTS.NAME))
    }

    @Test
    fun `a NUL character in a field is a 400, not a 500`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val created = newProject(boss)

        val response = put(generateJwtToken(boss), created.id, body(created, ""","subcontractors":"a\u0000b""""))

        assertEquals(HttpStatusCode.BadRequest, response.status)
    }
}
