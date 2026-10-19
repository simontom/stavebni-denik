package cz.stavebni.denik.services

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * The dimension limits of the airlock, applied to the header before anything is decoded. A progressive JPEG (and a JPEG with
 * one scan per component) makes the decoder keep the whole image, so it gets a lower limit than a baseline photo; the number
 * is justified by `ProgressiveJpegMemoryTest`.
 */
class ImageDecodeLimitsTest {

    private val sixteenMegapixels = PhotoService.MAX_PROGRESSIVE_JPEG_PIXELS

    private fun refusal(bytes: ByteArray): String =
        assertThrows<IllegalArgumentException> { PhotoService.decodeWithinLimits(bytes) }.message!!

    @Test
    fun `the limit for a progressive JPEG is 16 megapixels`() {
        assertEquals(16_000_000L, sixteenMegapixels)
    }

    @Test
    fun `a progressive JPEG whose header claims more than 16 megapixels is refused from its header`() {
        // A file of a few kilobytes that claims 5000 x 4000 = 20 MP. Had it been decoded, the answer would be about a damaged
        // file, not about the size: the message shows that the decision was made from the header.
        val claiming = JpegSamples.claiming(JpegSamples.smooth(200, 150, progressive = true), 5000, 4000)

        val message = refusal(claiming)

        assertTrue(message.contains("Progressive JPEG") && message.contains("16MP"), message)
    }

    @Test
    fun `one row more than 16 megapixels is refused`() {
        val claiming = JpegSamples.claiming(JpegSamples.smooth(200, 150, progressive = true), 4001, 4000)

        assertTrue(refusal(claiming).contains("16MP"))
    }

    @Test
    fun `a sequential JPEG with one scan per component is refused the same way, not let through as baseline`() {
        val claiming = JpegSamples.claiming(JpegSamples.nonInterleaved(200, 150), 5000, 4000)

        val message = refusal(claiming)

        assertTrue(message.contains("Progressive JPEG") && message.contains("16MP"), message)
    }

    @Test
    fun `a baseline JPEG above 16 megapixels is still within the limit that is reduced while decoding`() {
        val image = PhotoService.decodeWithinLimits(JpegSamples.smooth(6000, 4000)) // 24 MP

        assertTrue(image.width.toLong() * image.height <= 4_500_000L, "decoded reduced, not in full: ${image.width} x ${image.height}")
    }

    @Test
    fun `a baseline JPEG above 64 megapixels is refused as before`() {
        val claiming = JpegSamples.claiming(JpegSamples.smooth(200, 150), 9000, 9000)

        assertTrue(refusal(claiming).contains("64MP"))
    }

    // --- the number of scans: the CPU time of a decoder that cannot be cancelled ---------------------

    @Test
    fun `the cap on scans is 32, which leaves room above the ten of an ordinary progressive file`() {
        assertEquals(32, PhotoService.MAX_JPEG_SCANS)
    }

    @Test
    fun `a progressive JPEG with exactly 32 scans is decoded, with one more it is refused from its header`() {
        val base = JpegSamples.smooth(200, 150, progressive = true)

        val image = PhotoService.decodeWithinLimits(JpegSamples.withScansUpTo(base, 32)) // the extra scans are valid ones
        assertEquals(200, image.width)

        val message = refusal(JpegSamples.withScansUpTo(base, 33))
        assertTrue(message.contains("more than 32 scans"), message)
    }

    @Test
    fun `a file of thousands of tiny scans is refused at once, before any of them is decoded`() {
        // Every one of these scans makes a decoder walk all blocks of the image again. 5,000 of them on this small picture
        // already take it many seconds; the header walk must not wait for them.
        val hostile = JpegSamples.withScansUpTo(JpegSamples.smooth(1000, 1000, progressive = true), 5_000)

        val started = System.nanoTime()
        val message = refusal(hostile)
        val millis = (System.nanoTime() - started) / 1_000_000

        assertTrue(message.contains("more than 32 scans"), message)
        assertTrue(millis < 1_000, "refused in $millis ms")
    }

    @Test
    fun `a progressive JPEG with four components is refused, however small`() {
        val message = refusal(JpegSamples.fourComponents(200, 150))

        assertTrue(message.contains("more than 3 components"), message)
    }

    @Test
    fun `a sequential file with one scan per component has three scans and is decoded`() {
        // Far below the cap: for such a file it is the limit on pixels that matters (tested above).
        assertEquals(200, PhotoService.decodeWithinLimits(JpegSamples.nonInterleaved(200, 150)).width)
    }

    // --- two lines of defence: the header walk, and a bound inside the decoder ----------------------

    @AfterEach
    fun restoreTheRealLimits() {
        PhotoService.jpegWalker = JpegHeader::frameOf
        PhotoService.maxDecodePasses = PhotoService.MAX_DECODE_PASSES
        PhotoService.decodeDeadline = PhotoService.DECODE_DEADLINE
    }

    /** A progressive file that libjpeg decodes in thousands of passes, which a walk by declared length counts as 10 scans. */
    private fun hostile(): ByteArray = JpegSamples.withHiddenScans(JpegSamples.smooth(200, 200, progressive = true), 6_553)

    /** What a walk would say if it were fooled the way the file fools a walk by length: the file is a plain progressive one. */
    private val fooledWalk: (ByteArray) -> JpegHeader.Frame? = { JpegHeader.Frame(200, 200, 3, 2, 3, scans = 10) }

    @Test
    fun `a file that hides thousands of scans behind a reserved marker is refused by the header walk, at once`() {
        val started = System.nanoTime()
        val message = refusal(hostile())
        val millis = (System.nanoTime() - started) / 1_000_000

        assertTrue(message.contains("Invalid or corrupted"), message)
        assertTrue(millis < 1_000, "refused in $millis ms (decoding it takes tens of seconds at a megapixel)")
    }

    @Test
    fun `a file that gets past the header walk is stopped inside the decoder by the pass bound`() {
        PhotoService.jpegWalker = fooledWalk

        val started = System.nanoTime()
        val message = refusal(hostile())
        val millis = (System.nanoTime() - started) / 1_000_000

        assertTrue(message.contains("more than ${PhotoService.MAX_DECODE_PASSES} passes"), message)
        assertTrue(millis < 5_000, "stopped after $millis ms; without the bound it makes 6,563 passes")
    }

    @Test
    fun `a file that gets past the header walk is stopped inside the decoder by the deadline`() {
        PhotoService.jpegWalker = fooledWalk
        PhotoService.maxDecodePasses = Int.MAX_VALUE // only the clock is left
        PhotoService.decodeDeadline = java.time.Duration.ofMillis(300)

        val started = System.nanoTime()
        val message = refusal(hostile())
        val millis = (System.nanoTime() - started) / 1_000_000

        assertTrue(message.contains("longer than"), message)
        assertTrue(millis < 2_500, "stopped after $millis ms; without the bound the decode takes several seconds more")
    }

    @Test
    fun `the bounds are far above what an honest file needs`() {
        // 10 scans, as a phone or an editor writes a progressive photo; the worst accepted file (32 scans, 16 MP) is in
        // ProgressiveJpegMemoryTest.
        val image = PhotoService.decodeWithinLimits(JpegSamples.smooth(2000, 1500, progressive = true))

        assertEquals(2000, image.width)
        assertTrue(PhotoService.MAX_DECODE_PASSES > PhotoService.MAX_JPEG_SCANS, "an accepted file never reaches the pass bound")
    }

    @Test
    fun `a progressive JPEG within the limit is decoded`() {
        val image = PhotoService.decodeWithinLimits(JpegSamples.smooth(1200, 800, progressive = true))

        assertEquals(1200, image.width)
        assertEquals(800, image.height)
    }
}
