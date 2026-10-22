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
    fun `the start, interruption and resumption of work is saved through the API, limited like the other fields, and read back`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        val saved = save(token, projectId, """{"workDescription":"Betonáž","details":{"workStateChanges":"Zahájeno 28. 9. 2026, přerušeno pro déšť"}}""")
        assertEquals(HttpStatusCode.OK, saved.status, saved.bodyAsText())
        val read = client.get("/api/projects/$projectId/reports/2026-09-28") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(
            "Zahájeno 28. 9. 2026, přerušeno pro déšť",
            Json.parseToJsonElement(read.bodyAsText()).jsonObject["details"]!!.jsonObject["workStateChanges"]!!.jsonPrimitive.content,
        )

        val tooLong = save(token, projectId, """{"details":{"workStateChanges":"${"x".repeat(5001)}"}}""")
        assertEquals(HttpStatusCode.BadRequest, tooLong.status)
        assertTrue(tooLong.bodyAsText().contains("Zahájení, přerušení a obnovení prací"), "the message names the field by its label: ${tooLong.bodyAsText()}")
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

    @Test
    fun `leaving details out of a save keeps them, mentioning one changes only that one, an empty text clears it`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)
        save(token, projectId, """{"workDescription":"A","details":{"materials":"Cement","machinery":"Bagr"}}""")

        save(token, projectId, """{"workDescription":"B"}""")
        assertEquals(mapOf("materials" to "Cement", "machinery" to "Bagr"), detailsOf(token, projectId))

        save(token, projectId, """{"details":{"machinery":"Jeřáb"}}""")
        assertEquals(mapOf("materials" to "Cement", "machinery" to "Jeřáb"), detailsOf(token, projectId))

        save(token, projectId, """{"details":{"materials":""}}""")
        assertEquals(mapOf("machinery" to "Jeřáb"), detailsOf(token, projectId))
    }

    @Test
    fun `a text over the limit is a 400 over HTTP and the entry is unchanged`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)
        save(token, projectId, """{"workDescription":"A","details":{"materials":"Cement"}}""")

        val tooLong = save(token, projectId, """{"details":{"materials":"${"x".repeat(5001)}"}}""")

        assertEquals(HttpStatusCode.BadRequest, tooLong.status)
        assertEquals(mapOf("materials" to "Cement"), detailsOf(token, projectId))
        assertEquals(HttpStatusCode.OK, save(token, projectId, """{"details":{"materials":"${"x".repeat(5000)}"}}""").status)
    }

    @Test
    fun `the create-only route takes the fields too, and refuses what the save route refuses`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        val bad = client.post("/api/projects/$projectId/reports") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody("""{"date":"2026-09-28","workDescription":"A","details":{"nope":"x"}}""")
        }
        assertEquals(HttpStatusCode.BadRequest, bad.status)
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS))

        val created = client.post("/api/projects/$projectId/reports") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody("""{"date":"2026-09-28","workDescription":"A","details":{"defects":"Trhlina"}}""")
        }
        assertEquals(HttpStatusCode.Created, created.status, created.bodyAsText())
        assertEquals(mapOf("defects" to "Trhlina"), detailsOf(token, projectId))
    }

    @Test
    fun `a NUL character anywhere in the text is a 400, never a 500`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        for (body in listOf(
            """{"details":{"materials":"a\u0000b"}}""",
            """{"workDescription":"a\u0000b"}""",
            """{"constructionObj":"a\u0000b"}""",
            """{"workersByTrade":"[{\"trade\":\"Zedník\",\"count\":1,\"names\":[\"a\u0000b\"]}]"}""",
        )) {
            val response = save(token, projectId, body)
            assertEquals(HttpStatusCode.BadRequest, response.status, "$body -> ${response.bodyAsText()}")
        }
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS))
    }

    private suspend fun ApplicationTestBuilder.detailsOf(token: String, projectId: UUID): Map<String, String> {
        val read = client.get("/api/projects/$projectId/reports/2026-09-28") { header(HttpHeaders.Authorization, "Bearer $token") }
        return Json.parseToJsonElement(read.bodyAsText()).jsonObject["details"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
    }
}
