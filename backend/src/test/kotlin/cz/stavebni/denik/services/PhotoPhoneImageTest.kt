package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.awt.Color
import java.awt.GradientPaint
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.UUID
import javax.imageio.ImageIO

/** Photos as phones make them: big, and turned by an orientation tag instead of by their pixels. */
class PhotoPhoneImageTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val reportId: UUID)

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Phone Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
        return Site(boss, UUID.fromString(report.id))
    }

    /** A smooth picture compresses to a small file even at 24 megapixels, like a real photo of a wall does not but stays under the 5 MB limit. */
    private fun smoothJpeg(width: Int, height: Int): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val g = image.createGraphics()
        g.paint = GradientPaint(0f, 0f, Color.RED, width.toFloat(), height.toFloat(), Color.BLUE)
        g.fillRect(0, 0, width, height)
        g.dispose()
        val out = ByteArrayOutputStream()
        ImageIO.write(image, "jpeg", out)
        return out.toByteArray()
    }

    /** Left half red, right half blue: where the red ends up shows how the picture was turned. */
    private fun twoColourJpeg(width: Int, height: Int): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val g = image.createGraphics()
        g.color = Color.RED
        g.fillRect(0, 0, width / 2, height)
        g.color = Color.BLUE
        g.fillRect(width / 2, 0, width - width / 2, height)
        g.dispose()
        val out = ByteArrayOutputStream()
        ImageIO.write(image, "jpeg", out)
        return out.toByteArray()
    }

    /** The same JPEG with an EXIF block that says "orientation = [value]", as a camera writes it. */
    private fun withOrientation(jpeg: ByteArray, value: Int): ByteArray {
        val tiff = byteArrayOf(
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, // "II", 42, offset of the first IFD
            0x01, 0x00,                                     // one entry
            0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, value.toByte(), 0x00, 0x00, 0x00, // tag 0x0112, SHORT, 1, value
            0x00, 0x00, 0x00, 0x00,                         // no next IFD
        )
        val payload = "Exif".toByteArray() + byteArrayOf(0, 0) + tiff
        val length = payload.size + 2
        val app1 = byteArrayOf(0xFF.toByte(), 0xE1.toByte(), (length shr 8).toByte(), length.toByte()) + payload
        return jpeg.copyOfRange(0, 2) + app1 + jpeg.copyOfRange(2, jpeg.size)
    }

    /** The same JPEG with the size in its SOF header changed: a small file that claims a big picture. */
    private fun claimingSize(jpeg: ByteArray, width: Int, height: Int): ByteArray {
        val copy = jpeg.copyOf()
        var i = 2
        while (i + 9 < copy.size) {
            if (copy[i] == 0xFF.toByte() && (copy[i + 1].toInt() and 0xFF) in setOf(0xC0, 0xC2)) {
                copy[i + 5] = (height shr 8).toByte(); copy[i + 6] = height.toByte()
                copy[i + 7] = (width shr 8).toByte(); copy[i + 8] = width.toByte()
                return copy
            }
            i += 2 + (((copy[i + 2].toInt() and 0xFF) shl 8) or (copy[i + 3].toInt() and 0xFF))
        }
        error("no SOF marker")
    }

    private fun stored(photo: PhotoDto): BufferedImage {
        val row = dsl.selectFrom(PHOTOS).where(PHOTOS.ID.eq(photo.id)).fetchOne()!!
        return ImageIO.read(PhotoStorage.resolve(row.get(PHOTOS.PATHORIGINAL)!!)!!.toFile())
    }

    // --- size -----------------------------------------------------------------------------------

    @Test
    fun `a 12 megapixel phone photo is accepted and stored at the target size`() = runBlocking<Unit> {
        val s = site()
        val photo = PhotoService.uploadPhoto(s.boss, s.reportId, smoothJpeg(4000, 3000), "image/jpeg", "phone.jpg")

        assertEquals(1440, photo.width)
        assertEquals(1080, photo.height)
        val image = stored(photo)
        assertEquals(1440, image.width)
        assertEquals(1080, image.height)
    }

    @Test
    fun `a 24 megapixel photo is accepted too, decoded in reduced form`() = runBlocking<Unit> {
        val s = site()
        val big = smoothJpeg(6000, 4000)
        assertTrue(big.size < PhotoService.MAX_UPLOAD_BYTES, "the test picture must be within the file size limit, was ${big.size}")

        val photo = PhotoService.uploadPhoto(s.boss, s.reportId, big, "image/jpeg", "big.jpg")

        assertTrue(photo.width in 1618..1621, "about 1620 wide (rounding), was ${photo.width}")
        assertEquals(1080, photo.height)
    }

    @Test
    fun `a JPEG whose header claims more than 64 megapixels is refused from its header`() = runBlocking<Unit> {
        val s = site()
        val claiming = claimingSize(smoothJpeg(200, 150), 9000, 9000) // 81 MP in a file of a few kilobytes

        val ex = assertThrows<IllegalArgumentException> { PhotoService.uploadPhoto(s.boss, s.reportId, claiming, "image/jpeg", "bomb.jpg") }

        assertTrue(ex.message!!.contains("64MP"), ex.message)
        assertEquals(0, dsl.fetchCount(PHOTOS))
    }

    // --- orientation ----------------------------------------------------------------------------

    @Test
    fun `a photo recorded sideways is stored upright`() = runBlocking<Unit> {
        val s = site()
        // The camera held the phone upright: the sensor image is 300 x 100 and the tag asks for a 90 degree turn.
        val sideways = withOrientation(twoColourJpeg(300, 100), 6)

        val photo = PhotoService.uploadPhoto(s.boss, s.reportId, sideways, "image/jpeg", "portrait.jpg")

        assertEquals(100, photo.width, "the stored picture is turned: portrait")
        assertEquals(300, photo.height)
        val image = stored(photo)
        fun isRed(x: Int, y: Int) = Color(image.getRGB(x, y)).let { it.red > 150 && it.blue < 100 }
        fun isBlue(x: Int, y: Int) = Color(image.getRGB(x, y)).let { it.blue > 150 && it.red < 100 }
        // Turned 90 degrees clockwise, the left half (red) is now the top.
        assertTrue(isRed(50, 40), "top is red")
        assertTrue(isBlue(50, 260), "bottom is blue")
    }

    @Test
    fun `all eight orientations give the right shape, and a half turn puts the left side on the right`() = runBlocking<Unit> {
        val s = site()
        for (orientation in 1..8) {
            val photo = PhotoService.uploadPhoto(s.boss, s.reportId, withOrientation(twoColourJpeg(300, 100), orientation), "image/jpeg", "o$orientation.jpg")
            val swapped = orientation in 5..8
            assertEquals(if (swapped) 100 else 300, photo.width, "orientation $orientation")
            assertEquals(if (swapped) 300 else 100, photo.height, "orientation $orientation")
        }
        val half = PhotoService.uploadPhoto(s.boss, s.reportId, withOrientation(twoColourJpeg(300, 100), 3), "image/jpeg", "half.jpg")
        val image = stored(half)
        assertTrue(Color(image.getRGB(250, 50)).let { it.red > 150 && it.blue < 100 }, "rotated by 180 degrees, red is on the right")
    }

    @Test
    fun `a damaged orientation block never rejects a photo`() = runBlocking<Unit> {
        val s = site()
        val jpeg = twoColourJpeg(300, 100)
        // An EXIF block that claims a huge number of entries and then ends.
        val junk = "Exif".toByteArray() + byteArrayOf(0, 0) + byteArrayOf(0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0xFF.toByte(), 0xFF.toByte(), 1, 2, 3)
        val length = junk.size + 2
        val damaged = jpeg.copyOfRange(0, 2) + byteArrayOf(0xFF.toByte(), 0xE1.toByte(), (length shr 8).toByte(), length.toByte()) + junk + jpeg.copyOfRange(2, jpeg.size)

        val photo = PhotoService.uploadPhoto(s.boss, s.reportId, damaged, "image/jpeg", "damaged.jpg")

        assertEquals(300, photo.width, "treated as upright")
        assertEquals(100, photo.height)
    }

    @Test
    fun `orientation reading ignores things that are not a JPEG with EXIF`() {
        assertEquals(1, ImageOrientation.of(ByteArray(0)))
        assertEquals(1, ImageOrientation.of("not a jpeg".toByteArray()))
        assertEquals(1, ImageOrientation.of(twoColourJpeg(40, 40)), "a JPEG without EXIF is upright")
        assertEquals(8, ImageOrientation.of(withOrientation(twoColourJpeg(40, 40), 8)))
        assertEquals(1, ImageOrientation.of(withOrientation(twoColourJpeg(40, 40), 9)), "a value outside 1 to 8 is not an orientation")
        // The result is still a readable image whatever the tag said.
        assertNotNull(ImageIO.read(ByteArrayInputStream(withOrientation(twoColourJpeg(40, 40), 6))))
    }
}
