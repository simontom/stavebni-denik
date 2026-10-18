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

    // --- the scans: what the decoder's CPU time depends on ------------------------------------------

    @Test
    fun `the scans of a file are counted`() {
        assertEquals(1, frame(JpegSamples.smooth(300, 200)).scans, "a baseline photo has one scan")
        assertEquals(3, frame(JpegSamples.nonInterleaved(300, 200)).scans, "one per component")
        val progressive = frame(JpegSamples.smooth(300, 200, progressive = true)).scans
        assertTrue(progressive in 8..12, "the JDK's progressive script has about ten scans, had $progressive")
    }

    @Test
    fun `scans added to a file are counted, each as one`() {
        val base = JpegSamples.smooth(300, 200, progressive = true)
        val ordinary = frame(base).scans

        assertEquals(32, frame(JpegSamples.withScansUpTo(base, 32)).scans)
        assertEquals(33, frame(JpegSamples.withScansUpTo(base, 33)).scans)
        assertEquals(ordinary, frame(JpegSamples.withScansUpTo(base, ordinary)).scans)
    }

    @Test
    fun `bytes inside the data of a scan are not mistaken for the start of another one`() {
        val base = JpegSamples.smooth(300, 200, progressive = true)
        val ordinary = frame(base).scans
        // The data of a scan is binary. A stuffed FF 00 followed by DA and what looks like a scan header is data; so are the
        // restart markers FF D0..D7; fill bytes (FF FF) may come before the next real marker.
        val lookalike = byteArrayOf(
            0x12, 0xFF.toByte(), 0x00, 0xDA.toByte(), 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3F, 0x00,
            0xFF.toByte(), 0xD0.toByte(), 0x34, 0xFF.toByte(), 0xD7.toByte(), 0x56, 0xFF.toByte(), 0x00, 0xFF.toByte(), 0x00,
            0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), // fill before the closing marker
        )

        val withData = JpegSamples.withRawScan(base, lookalike)

        assertEquals(ordinary + 1, frame(withData).scans)
    }

    @Test
    fun `a file made of hundreds of thousands of tiny scans is walked in well under a second`() {
        // 12 bytes per scan: a 4 MB file of the kind that would keep a decoder busy for hours.
        val hostile = JpegSamples.withScansUpTo(JpegSamples.smooth(1000, 1000, progressive = true), 300_000)
        assertTrue(hostile.size < 5 * 1024 * 1024, "within the upload limit, was ${hostile.size}")

        val started = System.nanoTime()
        val f = frame(hostile)
        val millis = (System.nanoTime() - started) / 1_000_000

        assertEquals(300_000, f.scans)
        assertTrue(millis < 1_000, "the walk took $millis ms")
    }

    @Test
    fun `a file whose data ends before its closing marker is still counted up to there`() {
        val base = JpegSamples.smooth(300, 200, progressive = true)
        val cut = base.copyOf(base.size - 200) // the decoder copes with a truncated file, so do not refuse it as unreadable

        assertTrue(frame(cut).scans >= 1)
    }

    // --- components -----------------------------------------------------------------------------

    @Test
    fun `the number of components is read, and a four component progressive file is multi-scan`() {
        val four = frame(JpegSamples.fourComponents(200, 150))

        assertEquals(4, four.components)
        assertTrue(four.isMultiScan)
        assertEquals(3, frame(JpegSamples.smooth(200, 150, progressive = true)).components)
        assertEquals(1, frame(ByteArrayOutputStream().also { ImageIO.write(BufferedImage(64, 48, BufferedImage.TYPE_BYTE_GRAY), "jpeg", it) }.toByteArray()).components)
    }

    private fun ByteArray.indexOfSequence(pattern: ByteArray): Int {
        outer@ for (i in 0..size - pattern.size) {
            for (j in pattern.indices) if (this[i + j] != pattern[j]) continue@outer
            return i
        }
        error("pattern not found")
    }
}
