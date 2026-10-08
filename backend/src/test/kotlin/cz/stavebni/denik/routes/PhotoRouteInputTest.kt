package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.UUID
import javax.imageio.ImageIO

/** Which entry a photo belongs to: the one the client names, never a guess; and what an error says. */
class PhotoRouteInputTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val projectId: UUID, val reportId: UUID, val token: String)

    private suspend fun site(name: String = "Photo Input Project"): Site {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = name, address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val projectId = UUID.fromString(project.id)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28")
        return Site(boss, projectId, UUID.fromString(report.id), generateJwtToken(boss))
    }

    private fun jpeg(): ByteArray {
        val out = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(120, 90, BufferedImage.TYPE_INT_RGB), "jpeg", out)
        return out.toByteArray()
    }

    private suspend fun ApplicationTestBuilder.upload(token: String, fields: Map<String, String>): HttpResponse =
        client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                fields.forEach { (k, v) -> append(k, v) }
                append("photo", jpeg(), Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"p.jpg\"")
                })
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

    @Test
    fun `a photo needs the entry it belongs to, the newest entry of the project is not guessed`() = testApplication {
        application { module() }
        val s = site()

        val response = upload(s.token, mapOf("projectId" to s.projectId.toString()))

        assertEquals(HttpStatusCode.BadRequest, response.status, response.bodyAsText())
        assertTrue(response.bodyAsText().contains("reportId"), response.bodyAsText())
        assertEquals(0, dsl.fetchCount(PHOTOS))
    }

    @Test
    fun `a bare date needs its project, with it the photo goes to that entry`() = testApplication {
        application { module() }
        val s = site()

        val without = upload(s.token, mapOf("reportId" to "2026-09-28"))
        assertEquals(HttpStatusCode.BadRequest, without.status, without.bodyAsText())
        assertEquals(0, dsl.fetchCount(PHOTOS))

        val with = upload(s.token, mapOf("reportId" to "2026-09-28", "projectId" to s.projectId.toString()))
        assertEquals(HttpStatusCode.OK, with.status, with.bodyAsText())
        assertEquals(s.reportId.toString(), Json.parseToJsonElement(with.bodyAsText()).jsonObject["photo"]!!.jsonObject["reportId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a date that exists in two projects goes to the named project`() = testApplication {
        application { module() }
        val first = site("First")
        // The same member has another project with an entry for the same day, created later.
        val second = ProjectService.createProject(
            first.boss,
            ProjectDto(
                id = "", name = "Second", address = "Address", cadastralArea = "Area",
                parcelNumbers = "2", builder = "Builder", contractor = "Contractor", siteManagerId = first.boss.id.toString()
            )
        )
        val secondReport = DailyReportService.createReport(first.boss, UUID.fromString(second.id), "2026-09-28")

        val response = upload(first.token, mapOf("reportId" to "2026-09-28", "projectId" to first.projectId.toString()))

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val photoReport = dsl.selectFrom(PHOTOS).fetchOne()!!.reportid
        assertEquals(first.reportId, photoReport)
        assertNotEquals(UUID.fromString(secondReport.id), photoReport, "not the newer entry of the same day in the other project")
    }

    @Test
    fun `an unknown entry is a 404 and a malformed reference says nothing about the database`() = testApplication {
        application { module() }
        val s = site()

        val unknown = upload(s.token, mapOf("reportId" to UUID.randomUUID().toString()))
        assertEquals(HttpStatusCode.NotFound, unknown.status, unknown.bodyAsText())

        for (reference in listOf("+9999999-01-01", "2026-13-45", "not-a-date", "'; drop table photos; --")) {
            val response = upload(s.token, mapOf("reportId" to reference, "projectId" to s.projectId.toString()))
            val body = response.bodyAsText().lowercase()
            assertTrue(response.status.value in 400..404, "$reference: ${response.status}")
            for (leak in listOf("select ", "jooq", "sql", "postgres", "exception", "\"public\"")) {
                assertFalse(body.contains(leak), "'$reference' must not leak '$leak': $body")
            }
        }
        assertEquals(0, dsl.fetchCount(PHOTOS))
    }

    @Test
    fun `a photo is shown with a cache rule that makes the browser ask again`() = testApplication {
        application { module() }
        val s = site()
        val uploaded = upload(s.token, mapOf("reportId" to s.reportId.toString()))
        val photoId = Json.parseToJsonElement(uploaded.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

        val full = client.get("/api/photos/$photoId") { header(HttpHeaders.Authorization, "Bearer ${s.token}") }
        val thumb = client.get("/api/photos/$photoId/thumb") { header(HttpHeaders.Authorization, "Bearer ${s.token}") }

        assertEquals(HttpStatusCode.OK, full.status)
        assertEquals("private, no-cache", full.headers[HttpHeaders.CacheControl])
        assertEquals("private, no-cache", thumb.headers[HttpHeaders.CacheControl])
    }
}
