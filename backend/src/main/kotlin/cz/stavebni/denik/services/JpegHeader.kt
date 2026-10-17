package cz.stavebni.denik.services

/**
 * Reads, from the bytes of a JPEG and without decoding anything, how the decoder will have to work.
 *
 * The question is memory. The JDK's decoder (libjpeg) streams an ordinary photo: it needs a few rows at a time, whatever the
 * size of the picture. When the file has **several scans** it keeps the coefficients of the **whole image** (2 bytes per
 * sample, 3 to 6 bytes per pixel; measured in `ProgressiveJpegMemoryTest`) until the last scan has arrived. That happens
 * for a progressive file (frame type SOF2) and equally for a *sequential* file whose first scan holds fewer components
 * than the frame has (one scan per component): libjpeg and the JDK make no difference between them. A check for the
 * progressive marker alone would let such a file through.
 *
 * The walk follows the marker segments the way libjpeg does (it skips stray bytes, accepts fill bytes, skips segments by
 * their length), so the pair FF C2 inside the binary data of an EXIF or colour-profile segment is never taken for a marker.
 * Whatever cannot be followed gives `null`: the caller must treat a header it does not understand as unsafe, not as
 * ordinary.
 */
internal object JpegHeader {

    /**
     * @param sofType the frame type: 0 baseline, 1 extended sequential, 2 progressive (the marker is `0xFFC0 + sofType`)
     * @param components components in the frame (1 gray, 3 colour)
     * @param scanComponents components in the first scan
     */
    class Frame(val width: Int, val height: Int, val components: Int, val sofType: Int, val scanComponents: Int) {
        /** Whether the decoder keeps the coefficients of the whole image. Only the two sequential types are known to be streamed. */
        val isMultiScan: Boolean get() = (sofType != 0 && sofType != 1) || scanComponents < components
    }

    private const val FF = 0xFF
    private const val SOI = 0xD8
    private const val EOI = 0xD9
    private const val SOS = 0xDA
    private const val DHT = 0xC4
    private const val JPG = 0xC8
    private const val DAC = 0xCC
    private const val TEM = 0x01

    /** The frame and first scan the header describes, or `null` when it cannot be followed to the first scan. */
    fun frameOf(b: ByteArray): Frame? {
        if (b.size < 4 || u8(b, 0) != FF || u8(b, 1) != SOI) return null
        var pos = 2
        var sofType = -1
        var width = 0
        var height = 0
        var components = 0
        while (true) {
            // libjpeg's next_marker: skip anything that is not FF, swallow repeated FF (fill), and skip the stuffed FF 00.
            var marker: Int
            while (true) {
                while (pos < b.size && u8(b, pos) != FF) pos++
                while (pos < b.size && u8(b, pos) == FF) pos++
                if (pos >= b.size) return null
                marker = u8(b, pos++)
                if (marker != 0) break
            }
            when {
                marker == SOS -> {
                    if (sofType < 0) return null
                    if (pos + 3 > b.size) return null
                    val length = u16(b, pos)
                    val scanComponents = u8(b, pos + 2)
                    if (length < 6 || scanComponents < 1 || scanComponents > 4 || pos + length > b.size) return null
                    return Frame(width, height, components, sofType, scanComponents)
                }
                marker == EOI || marker == SOI -> return null // no scan before the end, or a second start
                marker in 0xC0..0xCF && marker != DHT && marker != JPG && marker != DAC -> {
                    if (sofType >= 0) return null // a second frame header: the decoder refuses the file
                    if (pos + 8 > b.size) return null
                    val length = u16(b, pos)
                    val count = u8(b, pos + 7)
                    if (count < 1 || length != 8 + 3 * count || pos + length > b.size) return null
                    height = u16(b, pos + 3)
                    width = u16(b, pos + 5)
                    if (width <= 0 || height <= 0) return null
                    components = count
                    sofType = marker - 0xC0
                    pos += length
                }
                marker in 0xD0..0xD7 || marker == TEM -> {} // markers without a payload
                else -> { // every other segment carries its own length, which includes the two length bytes
                    if (pos + 2 > b.size) return null
                    val length = u16(b, pos)
                    if (length < 2 || pos + length > b.size) return null
                    pos += length
                }
            }
        }
    }

    private fun u8(b: ByteArray, i: Int): Int = b[i].toInt() and 0xFF
    private fun u16(b: ByteArray, i: Int): Int = (u8(b, i) shl 8) or u8(b, i + 1)
}
