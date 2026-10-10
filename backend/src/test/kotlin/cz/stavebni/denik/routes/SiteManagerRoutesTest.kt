package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
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

/** Replacing the site manager through the HTTP API. */
class SiteManagerRoutesTest : BaseIntegrationTest() {

    private suspend fun newProject(manager: SessionUser): ProjectDto =
        ProjectService.createProject(
            manager,
            ProjectDto(
                id = "", name = "Dům", address = "Karlova 15", cadastralArea = "Brno", parcelNumbers = "1",
                builder = "Město", contractor = "Stavitel", siteManagerId = manager.id.toString(),
            )
        )

    private suspend fun ApplicationTestBuilder.change(token: String, projectId: String, body: String): HttpResponse =
        client.put("/api/projects/$projectId/site-manager") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private fun siteManager(): UUID = dsl.select(PROJECTS.SITEMANAGERID).from(PROJECTS).fetchSingle(PROJECTS.SITEMANAGERID)!!

    @Test
    fun `the manager replaces the site manager and the answer carries the new one`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = newProject(boss)
        addMember(UUID.fromString(created.id), deputy, Role.BOSS)

        val response = change(generateJwtToken(boss), created.id, """{"siteManagerId":"${deputy.id}","reason":"Střídání","updatedAt":"${created.updatedAt}"}""")

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertEquals(deputy.id.toString(), Json.parseToJsonElement(response.bodyAsText()).jsonObject["siteManagerId"]!!.jsonPrimitive.content)
        assertEquals(deputy.id, siteManager())
    }

    @Test
    fun `a worker gets 403, a member who is not a manager 409, no version 400, a stale version 409 with its code`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER)
        val created = newProject(boss)
        val id = UUID.fromString(created.id)
        addMember(id, deputy, Role.BOSS)
        addMember(id, worker, Role.WORKER)
        val bossToken = generateJwtToken(boss)

        assertEquals(HttpStatusCode.Forbidden, change(generateJwtToken(worker), created.id, """{"siteManagerId":"${deputy.id}","updatedAt":"${created.updatedAt}"}""").status)
        assertEquals(HttpStatusCode.Conflict, change(bossToken, created.id, """{"siteManagerId":"${worker.id}","updatedAt":"${created.updatedAt}"}""").status)
        assertEquals(HttpStatusCode.BadRequest, change(bossToken, created.id, """{"siteManagerId":"${deputy.id}"}""").status)
        assertEquals(HttpStatusCode.BadRequest, change(bossToken, created.id, """{"siteManagerId":"not-an-id","updatedAt":"${created.updatedAt}"}""").status)
        assertEquals(HttpStatusCode.OK, change(bossToken, created.id, """{"siteManagerId":"${deputy.id}","updatedAt":"${created.updatedAt}"}""").status)
        val stale = change(bossToken, created.id, """{"siteManagerId":"${boss.id}","updatedAt":"${created.updatedAt}"}""")
        assertEquals(HttpStatusCode.Conflict, stale.status)
        assertEquals("STALE_VERSION", Json.parseToJsonElement(stale.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
        assertEquals(deputy.id, siteManager())
    }
}
