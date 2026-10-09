package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
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

/** The fields of a daily entry that the vyhláška asks for, through the HTTP API. */
class EntryDetailsRoutesTest : BaseIntegrationTest() {

    private suspend fun project(owner: SessionUser): UUID =
        UUID.fromString(
            ProjectService.createProject(
                owner,
                ProjectDto(
                    id = "", name = "Náležitosti", address = "A", cadastralArea = "C", parcelNumbers = "1",
                    builder = "B", contractor = "C", siteManagerId = owner.id.toString(),
                )
            ).id
        )

    private suspend fun ApplicationTestBuilder.save(token: String, projectId: UUID, body: String): HttpResponse =
        client.post("/api/projects/$projectId/reports/2026-09-28") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    @Test
    fun `fields are saved through the API and read back`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        val saved = save(
            token, projectId,
            """{"workDescription":"Betonáž","details":{"materials":"Beton C25/30","accessibilityMeasures":"Obchozí trasa pro chodce"},"workersByTrade":"[{\"trade\":\"Zedníci\",\"count\":2,\"names\":[\"Jan Novák\"]}]"}""",
        )
        assertEquals(HttpStatusCode.OK, saved.status, saved.bodyAsText())

        val read = client.get("/api/projects/$projectId/reports/2026-09-28") { header(HttpHeaders.Authorization, "Bearer $token") }
        val json = Json.parseToJsonElement(read.bodyAsText()).jsonObject
        val details = json["details"]!!.jsonObject
        assertEquals("Beton C25/30", details["materials"]!!.jsonPrimitive.content)
        assertEquals("Obchozí trasa pro chodce", details["accessibilityMeasures"]!!.jsonPrimitive.content)
        assertEquals(2, details.size, "only the fields that have a text are returned")
        assertTrue(json["workersByTrade"]!!.jsonPrimitive.content.contains("Jan Novák"))
    }

    @Test
    fun `an unknown field is a 400 and changes nothing`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        val response = save(token, projectId, """{"workDescription":"Betonáž","details":{"signatureHash":"abc"}}""")

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS))
    }

    @Test
    fun `a field that is not text is a 400`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        for (body in listOf(
            """{"details":{"materials":5}}""",
            """{"details":{"materials":["a"]}}""",
            """{"details":"materials"}""",
        )) {
            val response = save(token, projectId, body)
            assertEquals(HttpStatusCode.BadRequest, response.status, body)
        }
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS))
    }
}
