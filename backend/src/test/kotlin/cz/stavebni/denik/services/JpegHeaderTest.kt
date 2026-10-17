package cz.stavebni.denik.services

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO

/**
 * What the header of a JPEG says about the memory its decoder will need. The decision is made from the header alone, before
 * a single pixel is decoded, so it has to be right about every shape of file that makes the decoder keep the whole image.
 */
class JpegHeaderTest {

    private fun frame(bytes: ByteArray) = JpegHeader.frameOf(bytes) ?: fail("the header was not understood")

    @Test
    fun `an ordinary baseline photo is a single scan with its real size`() {
        val f = frame(JpegSamples.smooth(300, 200))

        assertEquals(300, f.width)
        assertEquals(200, f.height)
        assertEquals(3, f.components)
        assertEquals(3, f.scanComponents)
        assertFalse(f.isMultiScan)
    }

    @Test
    fun `a gray baseline photo is a single scan too`() {
        val gray = ByteArrayOutputStream().also { ImageIO.write(BufferedImage(64, 48, BufferedImage.TYPE_BYTE_GRAY), "jpeg", it) }.toByteArray()

        val f = frame(gray)

        assertEquals(1, f.components)
        assertFalse(f.isMultiScan)
    }

    @Test
    fun `a progressive JPEG is multi-scan, whatever its sampling`() {
        assertTrue(frame(JpegSamples.smooth(300, 200, progressive = true)).isMultiScan)
        assertTrue(frame(JpegSamples.smooth(300, 200, progressive = true, fullChroma = true)).isMultiScan)
    }

    @Test
    fun `a sequential JPEG with one scan per component is multi-scan although it is not progressive`() {
        val bytes = JpegSamples.nonInterleaved(300, 200)

        val f = frame(bytes)

        assertEquals(0xC0, 0xC0 + f.sofType, "SOF0, the baseline marker: a check for SOF2 alone does not see this file")
        assertEquals(3, f.components)
        assertEquals(1, f.scanComponents)
        assertTrue(f.isMultiScan)
        // It really is a picture the decoder accepts, which is what makes it a way round a check for progressive files.
        assertEquals(300, ImageIO.read(ByteArrayInputStream(bytes)).width)
    }

    @Test
    fun `bytes that look like a progressive marker inside metadata are not mistaken for one`() {
        // EXIF and ICC data are binary: the pair FF C2 turns up in them by chance. Segments are skipped by their length.
        val noisy = ByteArray(2000) { if (it % 2 == 0) 0xFF.toByte() else 0xC2.toByte() }
        val bytes = JpegSamples.withApp1(JpegSamples.smooth(300, 200), noisy)

        assertFalse(frame(bytes).isMultiScan)
    }

    @Test
    fun `fill bytes before a marker are allowed, as the standard allows them`() {
        val plain = JpegSamples.smooth(300, 200)
        val padded = plain.copyOfRange(0, 2) + byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte()) + plain.copyOfRange(2, plain.size)

        val f = frame(padded)

        assertEquals(300, f.width)
        assertFalse(f.isMultiScan)
    }

    @Test
    fun `a header that cannot be followed is not understood, never guessed`() {
        val plain = JpegSamples.smooth(300, 200)
        val sof = plain.indexOfSequence(byteArrayOf(0xFF.toByte(), 0xC0.toByte()))

        assertNull(JpegHeader.frameOf(ByteArray(0)))
        assertNull(JpegHeader.frameOf("not a jpeg at all".toByteArray()))
        assertNull(JpegHeader.frameOf(plain.copyOf(sof + 4)), "cut inside the frame header")
        assertNull(JpegHeader.frameOf(plain.copyOf(sof)), "cut before the frame header")
        // A second frame header: the decoder refuses such a file, and so does this.
        val twice = plain.copyOfRange(0, sof) + plain.copyOfRange(sof, sof + 19) + plain.copyOfRange(sof, plain.size)
        assertNull(JpegHeader.frameOf(twice))
        // A segment whose length runs past the end.
        assertNull(JpegHeader.frameOf(plain.copyOfRange(0, 2) + byteArrayOf(0xFF.toByte(), 0xE1.toByte(), 0xFF.toByte(), 0xFF.toByte(), 1, 2, 3)))
    }

    private fun ByteArray.indexOfSequence(pattern: ByteArray): Int {
        outer@ for (i in 0..size - pattern.size) {
            for (j in pattern.indices) if (this[i + j] != pattern[j]) continue@outer
            return i
        }
        error("pattern not found")
    }
}
