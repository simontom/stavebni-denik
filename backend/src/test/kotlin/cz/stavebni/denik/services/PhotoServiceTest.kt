package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Paths
import java.util.UUID
import javax.imageio.ImageIO

class PhotoServiceTest : BaseIntegrationTest() {

    private fun createTestImageBytes(width: Int = 200, height: Int = 150, format: String = "png"): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val graphics = image.createGraphics()
        graphics.color = java.awt.Color.BLUE
        graphics.fillRect(0, 0, width, height)
        graphics.dispose()

        val baos = ByteArrayOutputStream()
        ImageIO.write(image, format, baos)
        return baos.toByteArray()
    }

    @Test
    fun `successful photo upload sanitizes and writes re-encoded jpeg`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Photo Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
        val reportId = UUID.fromString(report.id)

        val imageBytes = createTestImageBytes(800, 600, "png")
        val result = PhotoService.uploadPhoto(boss, reportId, imageBytes, "image/png", "site_photo.png")

        assertNotNull(result.id)
        assertEquals(reportId, result.reportId)
        assertEquals(boss.id, result.uploadedById)
        assertTrue(result.pathOriginal.endsWith(".jpg"))
        assertTrue(result.pathThumb.endsWith(".jpg"))

        // Verify disk files exist and are not empty
        val originalFile = Paths.get(result.pathOriginal)
        val thumbFile = Paths.get(result.pathThumb)
        assertTrue(Files.exists(originalFile))
        assertTrue(Files.exists(thumbFile))

        // Verify the stored files are genuine JPEG images
        val loadedImg = ImageIO.read(originalFile.toFile())
        assertNotNull(loadedImg)

        // Verify database entry
        val photosInDb = PhotoService.listPhotos(dsl, reportId)
        assertEquals(1, photosInDb.size)
        assertEquals(result.id, photosInDb[0].id)

        // Delete photo
        PhotoService.deletePhoto(boss, result.id)
        val photosAfterDelete = PhotoService.listPhotos(dsl, reportId)
        assertEquals(0, photosAfterDelete.size)

        val inDb = dsl.selectFrom(PHOTOS).where(PHOTOS.ID.eq(result.id)).fetchOne()
        assertNotNull(inDb)
        assertNotNull(inDb!!.get(PHOTOS.DELETEDAT))
    }

    @Test
    fun `uploadPhoto rejects non-image mime type`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            val reportId = UUID.randomUUID()

            assertThrows<IllegalArgumentException> {
                runBlocking {
                    PhotoService.uploadPhoto(boss, reportId, "text data".toByteArray(), "text/plain", "notes.txt")
                }
            }
        }
    }

    @Test
    fun `uploadPhoto rejects files exceeding 5MB limit`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            val reportId = UUID.randomUUID()
            val oversizedBytes = ByteArray(6 * 1024 * 1024) { 0xFF.toByte() }

            val ex = assertThrows<IllegalArgumentException> {
                runBlocking {
                    PhotoService.uploadPhoto(boss, reportId, oversizedBytes, "image/jpeg", "huge.jpg")
                }
            }
            assertTrue(ex.message!!.contains("5MB"))
        }
    }

    @Test
    fun `uploadPhoto rejects files with invalid magic bytes`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            val reportId = UUID.randomUUID()
            val fakeJpgBytes = "This is definitely not a JPEG image".toByteArray()

            val ex = assertThrows<IllegalArgumentException> {
                runBlocking {
                    PhotoService.uploadPhoto(boss, reportId, fakeJpgBytes, "image/jpeg", "fake.jpg")
                }
            }
            assertTrue(ex.message!!.contains("magic bytes"))
        }
    }

    @Test
    fun `uploadPhoto rejects SVG payload disguised as image`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            val reportId = UUID.randomUUID()
            val svgBytes = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".toByteArray()

            val ex = assertThrows<IllegalArgumentException> {
                runBlocking {
                    PhotoService.uploadPhoto(boss, reportId, svgBytes, "image/svg+xml", "malicious.svg")
                }
            }
            assertTrue(ex.message!!.contains("magic bytes"))
        }
    }

    @Test
    fun `uploadPhoto rejects image exceeding 8MP dimension limit`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            val project = ProjectService.createProject(boss, ProjectDto(
                id = "", name = "Photo 8MP Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            ))
            val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
            val reportId = UUID.fromString(report.id)

            // 4000 x 2500 = 10,000,000 pixels (> 8MP)
            val hugeImageBytes = createTestImageBytes(4000, 2500, "png")

            val ex = assertThrows<IllegalArgumentException> {
                runBlocking {
                    PhotoService.uploadPhoto(boss, reportId, hugeImageBytes, "image/png", "huge_dims.png")
                }
            }
            assertTrue(ex.message!!.contains("8MP"))
        }
    }

    @Test
    fun `uploadPhoto rejects photo upload on locked report`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            val project = ProjectService.createProject(boss, ProjectDto(
                id = "", name = "Locked Report Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            ))
            val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
            val reportId = UUID.fromString(report.id)

            // Sign / lock report
            DailyReportService.lockReport(boss, reportId)

            val imageBytes = createTestImageBytes(200, 150, "png")
            assertThrows<ForbiddenException> {
                runBlocking {
                    PhotoService.uploadPhoto(boss, reportId, imageBytes, "image/png", "photo_after_lock.png")
                }
            }
        }
    }
}

