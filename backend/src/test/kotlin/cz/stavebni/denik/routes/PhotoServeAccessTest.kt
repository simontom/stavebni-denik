package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.PhotoService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.time.OffsetDateTime
import java.util.UUID
import javax.imageio.ImageIO

/**
 * Photos are evidence from the construction site: GET /api/photos/{id} and
 * /thumb must only be served to logged-in members of the report's project, and
 * a photo the caller may not see must look exactly like a missing one.
 */
class PhotoServeAccessTest : BaseIntegrationTest() {

    private val variants = listOf("", "/thumb")

    private fun jpegBytes(): ByteArray {
        val image = BufferedImage(200, 150, BufferedImage.TYPE_INT_RGB)
        val baos = ByteArrayOutputStream()
        ImageIO.write(image, "jpeg", baos)
        return baos.toByteArray()
    }

    private suspend fun createProject(owner: SessionUser, name: String): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "",
                name = name,
                address = "Stavebni 10",
                cadastralArea = "Praha",
                parcelNumbers = "100/1",
                builder = "Investor a.s.",
                contractor = "Stavitel s.r.o.",
                siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    /** Creates a project owned by [boss] with one report and one uploaded photo; returns the photo id. */
    private suspend fun createPhotoOwnedBy(boss: SessionUser): UUID {
        val projectId = createProject(boss, "Photo Access Project")
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29")
        return PhotoService.uploadPhoto(boss, UUID.fromString(report.id), jpegBytes(), "image/jpeg", "site.jpg").id
    }

    @Test
    fun `photo and thumbnail require a session`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val photoId = createPhotoOwnedBy(boss)

        for (variant in variants) {
            val response = client.get("/api/photos/$photoId$variant")
            assertEquals(HttpStatusCode.Unauthorized, response.status, "GET /api/photos/{id}$variant without a session")
            assertNotEquals(ContentType.Image.JPEG, response.contentType()?.withoutParameters())
        }
    }

    @Test
    fun `photo and thumbnail of another project are answered with 404`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val photoId = createPhotoOwnedBy(boss)

        // A BOSS with a project of their own, but no membership in the photo's project.
        val outsider = createTestUser(role = Role.BOSS)
        createProject(outsider, "Somebody else's project")
        val outsiderToken = generateJwtToken(outsider)

        for (variant in variants) {
            val response = client.get("/api/photos/$photoId$variant") {
                header(HttpHeaders.Authorization, "Bearer $outsiderToken")
            }
            assertEquals(HttpStatusCode.NotFound, response.status, "GET /api/photos/{id}$variant as a non-member")
            assertNotEquals(ContentType.Image.JPEG, response.contentType()?.withoutParameters())
        }
    }

    @Test
    fun `project member gets the photo and thumbnail with private caching`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val photoId = createPhotoOwnedBy(boss)
        val token = generateJwtToken(boss)

        for (variant in variants) {
            val response = client.get("/api/photos/$photoId$variant") {
                header(HttpHeaders.Authorization, "Bearer $token")
            }
            assertEquals(HttpStatusCode.OK, response.status, "GET /api/photos/{id}$variant as a member")
            assertEquals(ContentType.Image.JPEG, response.contentType()?.withoutParameters())
            assertTrue(
                response.headers[HttpHeaders.CacheControl].orEmpty().contains("private"),
                "photos must not be cached by shared caches"
            )
            val bytes = response.bodyAsBytes()
            assertTrue(bytes.size > 2)
            assertEquals(0xFF, bytes[0].toInt() and 0xFF, "JPEG magic byte 1")
            assertEquals(0xD8, bytes[1].toInt() and 0xFF, "JPEG magic byte 2")
        }
    }

    @Test
    fun `unknown photo id returns 404`() = testApplication {
        application { module() }
        val token = generateJwtToken(createTestUser(role = Role.BOSS))

        for (variant in variants) {
            val response = client.get("/api/photos/${UUID.randomUUID()}$variant") {
                header(HttpHeaders.Authorization, "Bearer $token")
            }
            assertEquals(HttpStatusCode.NotFound, response.status)
        }
    }

    @Test
    fun `soft-deleted photo returns 404 even to its project member`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val photoId = createPhotoOwnedBy(boss)
        val token = generateJwtToken(boss)
        dsl.update(PHOTOS).set(PHOTOS.DELETEDAT, OffsetDateTime.now()).where(PHOTOS.ID.eq(photoId)).execute()

        for (variant in variants) {
            val response = client.get("/api/photos/$photoId$variant") {
                header(HttpHeaders.Authorization, "Bearer $token")
            }
            assertEquals(HttpStatusCode.NotFound, response.status)
        }
    }

    @Test
    fun `malformed photo id returns 400`() = testApplication {
        application { module() }
        val token = generateJwtToken(createTestUser(role = Role.BOSS))

        val response = client.get("/api/photos/not-a-uuid") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }
}
