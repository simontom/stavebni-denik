package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.PhotoStorage
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
import java.io.DataOutputStream
import java.nio.file.Files
import java.util.Random
import java.util.UUID
import java.util.zip.CRC32
import javax.imageio.ImageIO

/** Size, dimension and shape limits of the photo upload, and what is stored for an accepted photo. */
class PhotoUploadLimitsTest : BaseIntegrationTest() {

    private val storageKey = Regex("^photos/[0-9a-f-]{36}_(orig|thumb)[.]jpg$")

    private fun imageBytes(width: Int, height: Int, format: String, type: Int = BufferedImage.TYPE_INT_RGB, noise: Boolean = false): ByteArray {
        val image = BufferedImage(width, height, type)
        if (noise) {
            // Random pixels do not compress: a photo-sized image becomes a photo-sized file.
            val random = Random(42)
            for (y in 0 until height) for (x in 0 until width) image.setRGB(x, y, random.nextInt())
        } else {
            val g = image.createGraphics()
            g.color = java.awt.Color.ORANGE
            g.fillRect(0, 0, width, height)
            g.dispose()
        }
        val out = ByteArrayOutputStream()
        ImageIO.write(image, format, out)
        return out.toByteArray()
    }

    /** A PNG that is a few dozen bytes long but whose header claims [width] x [height] pixels. */
    private fun pngClaiming(width: Int, height: Int): ByteArray {
        fun chunk(type: String, data: ByteArray): ByteArray {
            val body = type.toByteArray(Charsets.US_ASCII) + data
            val out = ByteArrayOutputStream()
            DataOutputStream(out).apply {
                writeInt(data.size)
                write(body)
                writeInt(CRC32().apply { update(body) }.value.toInt())
            }
            return out.toByteArray()
        }
        val ihdr = ByteArrayOutputStream().also {
            DataOutputStream(it).apply { writeInt(width); writeInt(height); writeByte(8); writeByte(2); writeByte(0); writeByte(0); writeByte(0) }
        }.toByteArray()
        val signature = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val emptyZlib = byteArrayOf(0x78, 0x9C.toByte(), 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01)
        return signature + chunk("IHDR", ihdr) + chunk("IDAT", emptyZlib) + chunk("IEND", ByteArray(0))
    }

    private suspend fun createReport(boss: SessionUser): String {
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Upload Limits Project", address = "Stavebni 10", cadastralArea = "Praha",
                parcelNumbers = "100/1", builder = "Investor a.s.", contractor = "Stavitel s.r.o.",
                siteManagerId = boss.id.toString()
            )
        )
        return DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-29").id
    }

    private fun photoPart(builder: FormBuilder, name: String, bytes: ByteArray, mime: String = "image/jpeg", fileName: String = "photo.jpg") {
        builder.append(name, bytes, Headers.build {
            append(HttpHeaders.ContentType, mime)
            append(HttpHeaders.ContentDisposition, "filename=\"$fileName\"")
        })
    }

    private fun photoFiles(): Int {
        val dir = AppConfig.uploadsDir.resolve("photos")
        if (!Files.isDirectory(dir)) return 0
        return Files.list(dir).use { it.count().toInt() }
    }

    @Test
    fun `a realistic multi megabyte photo is accepted and its real size is stored`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)

        val jpeg = imageBytes(1600, 1200, "jpeg", noise = true)
        assertTrue(jpeg.size in 600_000..5_000_000, "the test image must be a few MB but under the limit, was ${jpeg.size}")

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", jpeg)
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val photoId = UUID.fromString(Json.parseToJsonElement(response.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content)
        val row = dsl.selectFrom(PHOTOS).where(PHOTOS.ID.eq(photoId)).fetchOne()!!

        // Scaled to fit 1920 x 1080; the stored numbers are those of the file that is really on disk.
        val stored = ImageIO.read(PhotoStorage.resolve(row.get(PHOTOS.PATHORIGINAL)!!)!!.toFile())
        assertEquals(stored.width, row.get(PHOTOS.WIDTH))
        assertEquals(stored.height, row.get(PHOTOS.HEIGHT))
        assertTrue(stored.width <= 1920 && stored.height <= 1080)
        assertEquals(1440, stored.width)
        assertEquals(1080, stored.height)
    }

    @Test
    fun `an image smaller than the target is stored without being scaled up`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", imageBytes(300, 200, "jpeg"))
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val row = dsl.selectFrom(PHOTOS).fetchOne()!!
        assertEquals(300, row.get(PHOTOS.WIDTH))
        assertEquals(200, row.get(PHOTOS.HEIGHT))
    }

    @Test
    fun `a PNG with an alpha channel is accepted and stored as a JPEG`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", imageBytes(120, 80, "png", type = BufferedImage.TYPE_INT_ARGB), mime = "image/png", fileName = "alpha.png")
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val row = dsl.selectFrom(PHOTOS).fetchOne()!!
        val bytes = Files.readAllBytes(PhotoStorage.resolve(row.get(PHOTOS.PATHORIGINAL)!!)!!)
        assertEquals(0xFF, bytes[0].toInt() and 0xFF)
        assertEquals(0xD8, bytes[1].toInt() and 0xFF)
    }

    @Test
    fun `an image whose header claims far more pixels than allowed is rejected before it is decoded`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)
        val filesBefore = photoFiles()

        // 50,000 x 50,000 = 2.5 gigapixels (about 10 GB as a bitmap) in a file of well under a kilobyte.
        val bomb = pngClaiming(50_000, 50_000)
        assertTrue(bomb.size < 200)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", bomb, mime = "image/png", fileName = "bomb.png")
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(response.bodyAsText().contains("MP limit"), "got: ${response.bodyAsText()}")
        assertEquals(0, dsl.selectCount().from(PHOTOS).fetchOne(0, Int::class.java))
        assertEquals(filesBefore, photoFiles(), "a rejected image must leave nothing on disk")
    }

    @Test
    fun `an extremely long thin image is rejected even though its pixel count is small`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", pngClaiming(1, 100_000), mime = "image/png", fileName = "thin.png")
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `garbage behind a valid image signature is a client error, not a server error`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)
        val noise = ByteArray(600).also { Random(1).nextBytes(it) }

        val samples = mapOf(
            "image/jpeg" to byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte()) + noise,
            "image/png" to byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) + noise,
            "image/webp" to "RIFF".toByteArray() + byteArrayOf(0, 0, 0, 0) + "WEBP".toByteArray() + noise
        )
        for ((mime, bytes) in samples) {
            val response = client.submitFormWithBinaryData(
                url = "/api/photos/upload",
                formData = formData {
                    append("reportId", reportId)
                    photoPart(this, "photo", bytes, mime = mime)
                }
            ) { header(HttpHeaders.Authorization, "Bearer $token") }

            assertEquals(HttpStatusCode.BadRequest, response.status, "$mime: ${response.bodyAsText()}")
        }
        assertEquals(0, dsl.selectCount().from(PHOTOS).fetchOne(0, Int::class.java))
    }

    @Test
    fun `a request body over the upload limit is refused with 413`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", ByteArray(7 * 1024 * 1024) { 0x41 })
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.PayloadTooLarge, response.status)
    }

    @Test
    fun `a JSON endpoint refuses a large body before anyone is logged in`() = testApplication {
        application { module() }

        val response = client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody("""{"nickname":"${"a".repeat(300_000)}","password":"x"}""")
        }

        assertEquals(HttpStatusCode.PayloadTooLarge, response.status)
    }

    @Test
    fun `two files in one upload are rejected`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)
        val image = imageBytes(100, 100, "jpeg")

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", image)
                photoPart(this, "photo2", image, fileName = "second.jpg")
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(0, dsl.selectCount().from(PHOTOS).fetchOne(0, Int::class.java))
    }

    @Test
    fun `an upload with a flood of form fields is rejected`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                for (i in 1..20) append("field$i", "x")
                photoPart(this, "photo", imageBytes(100, 100, "jpeg"))
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `an oversized text field is rejected`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", "7".repeat(100_000))
                photoPart(this, "photo", imageBytes(100, 100, "jpeg"))
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `the API shows an accepted photo without any file path and the row holds relative keys`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", imageBytes(200, 150, "jpeg"))
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val body = response.bodyAsText()
        val photo = Json.parseToJsonElement(body).jsonObject["photo"]!!.jsonObject
        assertEquals(setOf("id", "reportId", "width", "height", "bytes", "uploadedById"), photo.keys)
        assertFalse(body.contains(AppConfig.uploadsDir.toAbsolutePath().toString().replace("\\", "\\\\")), "no server path in the response")
        assertFalse(body.contains("_orig") || body.contains("_thumb"), "no storage key in the response")

        val row = dsl.selectFrom(PHOTOS).fetchOne()!!
        assertTrue(storageKey.matches(row.get(PHOTOS.PATHORIGINAL)!!), row.get(PHOTOS.PATHORIGINAL))
        assertTrue(storageKey.matches(row.get(PHOTOS.PATHTHUMB)!!), row.get(PHOTOS.PATHTHUMB))
    }

    @Test
    fun `a stored key that points outside the uploads directory is answered with 404`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)

        val upload = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                photoPart(this, "photo", imageBytes(200, 150, "jpeg"))
            }
        ) { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.OK, upload.status)
        val photoId = UUID.fromString(Json.parseToJsonElement(upload.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content)

        // Something outside the uploads directory that a naive "read whatever the row says" would serve.
        val outside = Files.createTempFile("not-a-photo", ".jpg")
        Files.write(outside, "secret".toByteArray())
        try {
            val escapes = listOf(
                outside.toAbsolutePath().toString(),
                "../" + outside.fileName,
                "photos/../../" + outside.fileName,
                "photos/${UUID.randomUUID()}_orig.png",
                "photos/${UUID.randomUUID()}_orig.jpg" // well-formed, but no such file
            )
            for (key in escapes) {
                dsl.update(PHOTOS).set(PHOTOS.PATHORIGINAL, key).where(PHOTOS.ID.eq(photoId)).execute()
                val response = client.get("/api/photos/$photoId") { header(HttpHeaders.Authorization, "Bearer $token") }
                assertEquals(HttpStatusCode.NotFound, response.status, "key '$key' must not be served")
                assertFalse(response.bodyAsText().contains("secret"))
            }
        } finally {
            Files.deleteIfExists(outside)
        }
    }

    @Test
    fun `files written for an upload are removed again when the database refuses the photo`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val reportId = createReport(boss)
        val filesBefore = photoFiles()

        // NOT VALID: existing rows are not checked, every new row is - so the INSERT fails after the files were written.
        dsl.execute("""ALTER TABLE "photos" ADD CONSTRAINT zz_test_refuse_photos CHECK (false) NOT VALID""")
        try {
            val response = client.submitFormWithBinaryData(
                url = "/api/photos/upload",
                formData = formData {
                    append("reportId", reportId)
                    photoPart(this, "photo", imageBytes(200, 150, "jpeg"))
                }
            ) { header(HttpHeaders.Authorization, "Bearer $token") }
            assertFalse(response.status.isSuccess())
        } finally {
            dsl.execute("""ALTER TABLE "photos" DROP CONSTRAINT zz_test_refuse_photos""")
        }

        assertEquals(0, dsl.selectCount().from(PHOTOS).fetchOne(0, Int::class.java))
        assertEquals(filesBefore, photoFiles(), "no orphaned files may remain")
    }
}
