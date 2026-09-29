package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.PHOTOS
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import javax.imageio.ImageIO

class PhotoAndPdfAdversarialTest : BaseIntegrationTest() {

    private fun createTestImageBytes(width: Int = 200, height: Int = 150, format: String = "jpeg"): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val graphics = image.createGraphics()
        graphics.color = java.awt.Color.RED
        graphics.fillRect(0, 0, width, height)
        graphics.dispose()

        val baos = ByteArrayOutputStream()
        ImageIO.write(image, format, baos)
        return baos.toByteArray()
    }

    private suspend fun createProjectAndReport(bossRole: Role = Role.BOSS): Pair<String, String> {
        val boss = createTestUser(role = bossRole)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "",
                name = "Airlock Test Project",
                address = "Stavebni 10",
                cadastralArea = "Praha",
                parcelNumbers = "100/1",
                builder = "Investor a.s.",
                contractor = "Stavitel s.r.o.",
                siteManagerId = boss.id.toString()
            )
        )
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-29")
        return Pair(project.id, report.id)
    }

    // ==========================================
    // 1. Photo Upload Airlock Adversarial Tests
    // ==========================================

    @Test
    fun `POST photos upload with invalid magic bytes text file returns 400 Bad Request`() = testApplication {
        application { module() }

        val client = createClient {
            install(ContentNegotiation) { json() }
        }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val (_, reportId) = createProjectAndReport()

        val fakeImageBytes = "This is a plain text file pretending to be a JPG".toByteArray()

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                append("photo", fakeImageBytes, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"fake.jpg\"")
                })
            }
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("magic bytes"), "Expected magic bytes rejection error message, got: $body")

        // Verify NO record in DB
        val reportUuid = UUID.fromString(reportId)
        val countInDb = dsl.selectCount().from(PHOTOS).where(PHOTOS.REPORTID.eq(reportUuid)).fetchOne(0, Int::class.java)
        assertEquals(0, countInDb, "DB should not contain photo record after failed upload")
    }

    @Test
    fun `POST photos upload with SVG payload returns 400 Bad Request`() = testApplication {
        application { module() }

        val client = createClient {
            install(ContentNegotiation) { json() }
        }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val (_, reportId) = createProjectAndReport()

        val svgBytes = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".toByteArray()

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                append("photo", svgBytes, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"xss.jpg\"")
                })
            }
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("magic bytes") || body.contains("Invalid"), "Expected rejection error, got: $body")

        val reportUuid = UUID.fromString(reportId)
        val countInDb = dsl.selectCount().from(PHOTOS).where(PHOTOS.REPORTID.eq(reportUuid)).fetchOne(0, Int::class.java)
        assertEquals(0, countInDb)
    }

    @Test
    fun `POST photos upload with file exceeding 5MB limit returns 400 Bad Request`() = testApplication {
        application { module() }

        val client = createClient {
            install(ContentNegotiation) { json() }
        }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val (_, reportId) = createProjectAndReport()

        // 5.5 MB payload
        val oversizedBytes = ByteArray(5500 * 1024) { 0xFF.toByte() }

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                append("photo", oversizedBytes, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"huge.jpg\"")
                })
            }
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("5MB"), "Expected 5MB limit error, got: $body")

        val reportUuid = UUID.fromString(reportId)
        val countInDb = dsl.selectCount().from(PHOTOS).where(PHOTOS.REPORTID.eq(reportUuid)).fetchOne(0, Int::class.java)
        assertEquals(0, countInDb)
    }

    @Test
    fun `POST photos upload with valid JPEG creates real files on disk and real DB rows`() = testApplication {
        application { module() }

        val client = createClient {
            install(ContentNegotiation) { json() }
        }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val (_, reportId) = createProjectAndReport()

        val jpegBytes = createTestImageBytes(400, 300, "jpeg")
        // Verify valid JPEG magic bytes in generated array
        assertTrue((jpegBytes[0].toInt() and 0xFF) == 0xFF)
        assertTrue((jpegBytes[1].toInt() and 0xFF) == 0xD8)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                append("photo", jpegBytes, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"site_construction.jpg\"")
                })
            }
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val bodyText = response.bodyAsText()
        val json = Json.parseToJsonElement(bodyText).jsonObject
        assertEquals("ok", json["status"]?.jsonPrimitive?.content)
        val photoIdStr = json["id"]?.jsonPrimitive?.content
        assertNotNull(photoIdStr)
        val photoUuid = UUID.fromString(photoIdStr!!)

        // Verify DB row in PostgreSQL
        val dbRecord = dsl.selectFrom(PHOTOS).where(PHOTOS.ID.eq(photoUuid)).fetchOne()
        assertNotNull(dbRecord, "Photo record must exist in PostgreSQL database")
        assertEquals(UUID.fromString(reportId), dbRecord!!.get(PHOTOS.REPORTID))
        assertEquals(boss.id, dbRecord.get(PHOTOS.UPLOADEDBYID))
        assertNull(dbRecord.get(PHOTOS.DELETEDAT))
        assertTrue(dbRecord.get(PHOTOS.BYTES)!! > 0)
        assertEquals(400, dbRecord.get(PHOTOS.WIDTH))
        assertEquals(300, dbRecord.get(PHOTOS.HEIGHT))

        // Verify real file saving on disk
        val origPathStr = dbRecord.get(PHOTOS.PATHORIGINAL)!!
        val thumbPathStr = dbRecord.get(PHOTOS.PATHTHUMB)!!
        val origFile = File(origPathStr)
        val thumbFile = File(thumbPathStr)

        assertTrue(origFile.exists(), "Original file must exist at $origPathStr")
        assertTrue(origFile.length() > 0, "Original file size must be > 0")
        assertTrue(thumbFile.exists(), "Thumb file must exist at $thumbPathStr")
        assertTrue(thumbFile.length() > 0, "Thumb file size must be > 0")

        // Verify file is a valid readable JPEG on disk
        val loadedImage = ImageIO.read(origFile)
        assertNotNull(loadedImage, "Saved file must be readable as a real image")
        val fileBytes = origFile.readBytes()
        assertTrue((fileBytes[0].toInt() and 0xFF) == 0xFF)
        assertTrue((fileBytes[1].toInt() and 0xFF) == 0xD8)

        // Verify GET /api/photos/{id} serves the real file
        val getPhotoResp = client.get("/api/photos/$photoUuid")
        assertEquals(HttpStatusCode.OK, getPhotoResp.status)
        val photoContentType = getPhotoResp.headers[HttpHeaders.ContentType]
        assertNotNull(photoContentType)
        assertTrue(photoContentType!!.contains("image/jpeg"))
        val downloadedBytes = getPhotoResp.bodyAsBytes()
        assertEquals(fileBytes.size, downloadedBytes.size)

        // Verify GET /api/photos/{id}/thumb serves the thumbnail
        val getThumbResp = client.get("/api/photos/$photoUuid/thumb")
        assertEquals(HttpStatusCode.OK, getThumbResp.status)
        val thumbContentType = getThumbResp.headers[HttpHeaders.ContentType]
        assertNotNull(thumbContentType)
        assertTrue(thumbContentType!!.contains("image/jpeg"))
        assertTrue(getThumbResp.bodyAsBytes().isNotEmpty())
    }

    @Test
    fun `POST photos upload rejected on locked report with 403 Forbidden`() = testApplication {
        application { module() }

        val client = createClient {
            install(ContentNegotiation) { json() }
        }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val (_, reportId) = createProjectAndReport()

        // Lock report
        DailyReportService.lockReport(boss, UUID.fromString(reportId))

        val jpegBytes = createTestImageBytes(200, 150, "jpeg")
        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                append("photo", jpegBytes, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"locked.jpg\"")
                })
            }
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.Forbidden, response.status)
    }

    // ==========================================
    // 2. PDF Download Adversarial Tests
    // ==========================================

    @Test
    fun `GET report pdf returns real application pdf binary stream with valid magic bytes`() = testApplication {
        application { module() }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val (_, reportId) = createProjectAndReport()

        val response = client.get("/api/reports/$reportId/pdf") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.OK, response.status)

        // Verify Content-Type is real application/pdf
        val contentType = response.headers[HttpHeaders.ContentType]
        assertNotNull(contentType, "Content-Type header must be present")
        assertTrue(contentType!!.startsWith("application/pdf"), "Expected application/pdf, got: $contentType")

        // Verify Content-Disposition header
        val contentDisp = response.headers[HttpHeaders.ContentDisposition]
        assertNotNull(contentDisp)
        assertTrue(contentDisp!!.contains("attachment"))
        assertTrue(contentDisp.contains(".pdf"))

        // Verify real PDF binary content
        val bodyBytes = response.bodyAsBytes()
        assertTrue(bodyBytes.size > 50, "PDF size must be substantial")

        // Real PDF magic bytes: %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
        assertEquals('%'.code.toByte(), bodyBytes[0])
        assertEquals('P'.code.toByte(), bodyBytes[1])
        assertEquals('D'.code.toByte(), bodyBytes[2])
        assertEquals('F'.code.toByte(), bodyBytes[3])
        assertEquals('-'.code.toByte(), bodyBytes[4])

        // Verify EOF marker
        val bodyStr = String(bodyBytes, Charsets.ISO_8859_1)
        assertTrue(bodyStr.contains("%%EOF"), "PDF binary must contain %%EOF marker")
    }

    @Test
    fun `GET report pdf for locked report returns 200 OK and valid PDF binary stream`() = testApplication {
        application { module() }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val (_, reportId) = createProjectAndReport()

        // Lock report first
        DailyReportService.lockReport(boss, UUID.fromString(reportId))

        val response = client.get("/api/reports/$reportId/pdf") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val contentType = response.headers[HttpHeaders.ContentType]
        assertNotNull(contentType)
        assertTrue(contentType!!.startsWith("application/pdf"))

        val bodyBytes = response.bodyAsBytes()
        assertTrue(bodyBytes.size > 50)
        assertEquals('%'.code.toByte(), bodyBytes[0])
        assertEquals('P'.code.toByte(), bodyBytes[1])
        assertEquals('D'.code.toByte(), bodyBytes[2])
        assertEquals('F'.code.toByte(), bodyBytes[3])
        assertEquals('-'.code.toByte(), bodyBytes[4])
    }

    @Test
    fun `GET report pdf for non-existent report returns 400 Bad Request`() = testApplication {
        application { module() }

        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)

        val response = client.get("/api/reports/${UUID.randomUUID()}/pdf") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
    }
}
