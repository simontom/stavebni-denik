package cz.stavebni.denik.services

import java.awt.Color
import java.awt.GradientPaint
import java.awt.image.BufferedImage
import java.awt.image.DataBuffer
import java.awt.image.Raster
import java.io.ByteArrayOutputStream
import javax.imageio.IIOImage
import javax.imageio.ImageIO
import javax.imageio.ImageTypeSpecifier
import javax.imageio.ImageWriteParam
import javax.imageio.metadata.IIOMetadataNode
import org.w3c.dom.Node

/**
 * JPEG files of the shapes the upload limits care about. The same image content in every shape: a smooth gradient, which is
 * a small file whatever its size (the memory a decoder needs depends on the size of the picture, not of the file).
 */
internal object JpegSamples {

    private const val METADATA_FORMAT = "javax_imageio_jpeg_image_1.0"

    /**
     * A JPEG made by the JDK's own encoder. [progressive] writes several scans (SOF2); [fullChroma] gives all three components
     * the full resolution (4:4:4), the largest a decoder has to keep per pixel (the default is 4:2:0).
     */
    fun smooth(width: Int, height: Int, progressive: Boolean = false, fullChroma: Boolean = false): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_3BYTE_BGR)
        val g = image.createGraphics()
        g.paint = GradientPaint(0f, 0f, Color.RED, width.toFloat(), height.toFloat(), Color.BLUE)
        g.fillRect(0, 0, width, height)
        g.dispose()

        val writer = ImageIO.getImageWritersByFormatName("jpeg").next()
        try {
            val param = writer.defaultWriteParam
            param.compressionMode = ImageWriteParam.MODE_EXPLICIT
            param.compressionQuality = 0.9f
            if (progressive) param.progressiveMode = ImageWriteParam.MODE_DEFAULT
            val metadata = writer.getDefaultImageMetadata(ImageTypeSpecifier.createFromRenderedImage(image), param)
            if (fullChroma) {
                val tree = metadata.getAsTree(METADATA_FORMAT)
                forEachNode(tree) { node ->
                    if (node.nodeName == "componentSpec") {
                        (node as IIOMetadataNode).setAttribute("HsamplingFactor", "1")
                        node.setAttribute("VsamplingFactor", "1")
                    }
                }
                metadata.setFromTree(METADATA_FORMAT, tree)
            }
            val out = ByteArrayOutputStream()
            ImageIO.createImageOutputStream(out).use { stream ->
                writer.output = stream
                writer.write(null, IIOImage(image, null, metadata), param)
            }
            return out.toByteArray()
        } finally {
            writer.dispose()
        }
    }

    /**
     * A **sequential** (SOF0, not progressive) JPEG of three components with one scan per component. A decoder treats it
     * like a progressive one: it has to keep the coefficients of the whole image. Built from a gray JPEG, whose single scan
     * is exactly what a one-component scan of a 1x1 sampled component looks like, repeated for each component.
     */
    fun nonInterleaved(width: Int, height: Int): ByteArray {
        val gray = BufferedImage(width, height, BufferedImage.TYPE_BYTE_GRAY)
        val g = gray.createGraphics()
        g.paint = GradientPaint(0f, 0f, Color.BLACK, width.toFloat(), height.toFloat(), Color.WHITE)
        g.fillRect(0, 0, width, height)
        g.dispose()
        val source = ByteArrayOutputStream().also { ImageIO.write(gray, "jpeg", it) }.toByteArray()

        val tables = ByteArrayOutputStream() // the quantisation and Huffman tables, kept as they are
        var scan: ByteArray? = null
        var pos = 2
        while (pos + 4 <= source.size && scan == null) {
            val marker = source[pos + 1].toInt() and 0xFF
            val length = ((source[pos + 2].toInt() and 0xFF) shl 8) or (source[pos + 3].toInt() and 0xFF)
            when (marker) {
                0xDA -> scan = source.copyOfRange(pos + 2 + length, source.size - 2) // up to the closing EOI
                0xDB, 0xC4 -> tables.write(source, pos, 2 + length)
            }
            pos += 2 + length
        }
        val data = requireNotNull(scan) { "no scan in the gray JPEG" }

        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0xFF.toByte(), 0xD8.toByte()))
        out.write(tables.toByteArray())
        // SOF0: 8 bits, height, width, three components of 1x1 sampling, all using quantisation table 0.
        out.write(byteArrayOf(0xFF.toByte(), 0xC0.toByte(), 0, 17, 8, (height shr 8).toByte(), height.toByte(), (width shr 8).toByte(), width.toByte(), 3))
        for (id in 1..3) out.write(byteArrayOf(id.toByte(), 0x11, 0))
        for (id in 1..3) {
            // SOS of ONE component (this is what makes the file non-interleaved), standard table 0 for DC and AC.
            out.write(byteArrayOf(0xFF.toByte(), 0xDA.toByte(), 0, 8, 1, id.toByte(), 0x00, 0, 63, 0))
            out.write(data)
        }
        out.write(byteArrayOf(0xFF.toByte(), 0xD9.toByte()))
        return out.toByteArray()
    }

    /**
     * [jpeg], a progressive 3-component file made by [smooth], with extra scans appended so that it has [total] scans. Each
     * extra scan is what a hostile file is made of: a valid initial AC scan of one component (all coefficients, no
     * successive approximation) whose data is nothing but "end of band" runs that cover every block of the component. It is
     * 12 bytes long, and yet the decoder walks every block of the image again for it.
     */
    fun withScansUpTo(jpeg: ByteArray, total: Int): ByteArray {
        val frame = requireNotNull(JpegHeader.frameOf(jpeg)) { "not a JPEG the header walk understands" }
        require(frame.scans <= total) { "the file already has ${frame.scans} scans" }
        val extra = total - frame.scans
        if (extra == 0) return jpeg

        // The component ids, from the SOF segment, and the number of blocks of a full-size component.
        var pos = 2
        var ids = IntArray(0)
        while (pos + 4 <= jpeg.size) {
            val marker = jpeg[pos + 1].toInt() and 0xFF
            val length = ((jpeg[pos + 2].toInt() and 0xFF) shl 8) or (jpeg[pos + 3].toInt() and 0xFF)
            if (marker == 0xC2) {
                ids = IntArray(frame.components) { jpeg[pos + 10 + 3 * it].toInt() and 0xFF }
                break
            }
            pos += 2 + length
        }
        require(ids.isNotEmpty()) { "no progressive frame header" }
        val blocks = ((frame.width + 7) / 8).toLong() * ((frame.height + 7) / 8)

        // Symbol 0xE0 is "end of band run of 2^14 + 14 extra bits": up to 32,767 blocks per symbol.
        val symbols = ((blocks + 32_766) / 32_767).toInt()
        val bits = StringBuilder()
        repeat(symbols) { bits.append('0').append("11111111111111") }
        while (bits.length % 8 != 0) bits.append('1')
        val data = ByteArrayOutputStream()
        for (i in 0 until bits.length step 8) {
            val b = bits.substring(i, i + 8).toInt(2)
            data.write(b)
            if (b == 0xFF) data.write(0) // byte stuffing
        }
        // DHT: an AC table 0 with one code of length 1, for the symbol 0xE0 (16 counts, one symbol).
        val dht = byteArrayOf(0xFF.toByte(), 0xC4.toByte(), 0, 20, 0x10, 1) + ByteArray(15) + byteArrayOf(0xE0.toByte())

        val out = ByteArrayOutputStream()
        out.write(jpeg, 0, jpeg.size - 2) // everything but the closing EOI
        for (i in 0 until extra) {
            if (i == 0) out.write(dht) // the table persists for the scans after it
            out.write(byteArrayOf(0xFF.toByte(), 0xDA.toByte(), 0, 8, 1, ids[i % ids.size].toByte(), 0x00, 1, 63, 0x00))
            out.write(data.toByteArray())
        }
        out.write(byteArrayOf(0xFF.toByte(), 0xD9.toByte()))
        return out.toByteArray()
    }

    /**
     * [jpeg] (a progressive file made by [smooth]) turned into a file in which a walk that skips an unknown marker "by its
     * declared length" misses [hiddenScans] scans, and libjpeg does not.
     *
     * A restart interval is set; the last scan has its data cut off; and after its header comes a **reserved marker**
     * (`FF 02`, in 0x02..0xBF) that declares a length of 65,535 bytes, whose "payload" is nothing but bare scan headers. A
     * walk that trusts the length skips all of it and sees the closing EOI. libjpeg, running out of data in that scan, comes
     * to a restart boundary with the reserved marker pending, takes it for garbage, and scans forward to the next marker:
     * the first scan header in the payload, and then the next, and the next. At most 6,553 headers fit.
     */
    fun withHiddenScans(jpeg: ByteArray, hiddenScans: Int): ByteArray {
        require(hiddenScans in 1..6_553) { "a reserved marker holds at most 6,553 scan headers" }
        // The last FF DA of a valid file is its last scan header: inside entropy data FF is always followed by 00 or a marker.
        var sos = -1
        for (i in jpeg.size - 2 downTo 2) if (jpeg[i] == 0xFF.toByte() && jpeg[i + 1] == 0xDA.toByte()) { sos = i; break }
        require(sos > 0) { "no scan header" }
        val headerEnd = sos + 2 + (((jpeg[sos + 2].toInt() and 0xFF) shl 8) or (jpeg[sos + 3].toInt() and 0xFF))

        val dri = byteArrayOf(0xFF.toByte(), 0xDD.toByte(), 0, 4, 0, 4) // restart interval: 4 MCUs
        val bareScan = byteArrayOf(0xFF.toByte(), 0xDA.toByte(), 0, 8, 1, 1, 0x00, 1, 63, 0x00) // component 1, AC 1..63, no refinement
        val payload = ByteArrayOutputStream()
        repeat(hiddenScans) { payload.write(bareScan) }
        while (payload.size() < 65_533) payload.write(0) // the declared length counts its own two bytes: 65,535 - 2

        val out = ByteArrayOutputStream()
        out.write(jpeg, 0, 2)
        out.write(dri)
        out.write(jpeg, 2, headerEnd - 2)
        out.write(byteArrayOf(0xFF.toByte(), 0x02, 0xFF.toByte(), 0xFF.toByte()))
        out.write(payload.toByteArray())
        out.write(byteArrayOf(0xFF.toByte(), 0xD9.toByte()))
        return out.toByteArray()
    }

    /** [jpeg] with a segment of [marker] (FF marker, 2-byte length, [payload]) put right before the closing EOI. */
    fun withSegmentBeforeEnd(jpeg: ByteArray, marker: Int, payload: ByteArray): ByteArray {
        val length = payload.size + 2
        val out = ByteArrayOutputStream()
        out.write(jpeg, 0, jpeg.size - 2)
        out.write(byteArrayOf(0xFF.toByte(), marker.toByte(), (length shr 8).toByte(), length.toByte()))
        out.write(payload)
        out.write(byteArrayOf(0xFF.toByte(), 0xD9.toByte()))
        return out.toByteArray()
    }

    /** [jpeg] with one more scan of component 1 whose data is exactly [data] (binary, for the header walk only; not decodable). */
    fun withRawScan(jpeg: ByteArray, data: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(jpeg, 0, jpeg.size - 2)
        out.write(byteArrayOf(0xFF.toByte(), 0xDA.toByte(), 0, 8, 1, 1, 0x00, 1, 63, 0x00))
        out.write(data)
        out.write(byteArrayOf(0xFF.toByte(), 0xD9.toByte()))
        return out.toByteArray()
    }

    /**
     * A progressive JPEG of **four** components (a CMYK-like file), small. The JDK decodes such a file, and keeps 8 bytes per
     * pixel for it, more than for a colour one.
     */
    fun fourComponents(width: Int, height: Int): ByteArray {
        val raster = Raster.createInterleavedRaster(DataBuffer.TYPE_BYTE, width, height, 4, null)
        val pixel = IntArray(4)
        for (y in 0 until height) for (x in 0 until width) {
            for (b in 0 until 4) pixel[b] = (x * 255 / width + b * 40) and 0xFF
            raster.setPixel(x, y, pixel)
        }
        val writer = ImageIO.getImageWritersByFormatName("jpeg").next()
        try {
            val param = writer.defaultWriteParam
            param.progressiveMode = ImageWriteParam.MODE_DEFAULT
            val out = ByteArrayOutputStream()
            ImageIO.createImageOutputStream(out).use { stream ->
                writer.output = stream
                writer.write(null, IIOImage(raster, null, null), param)
            }
            return out.toByteArray()
        } finally {
            writer.dispose()
        }
    }

    /** The same JPEG with the size in its SOF header changed: a small file that claims a big picture. */
    fun claiming(jpeg: ByteArray, width: Int, height: Int): ByteArray {
        val copy = jpeg.copyOf()
        var i = 2
        while (i + 9 < copy.size) {
            if (copy[i] == 0xFF.toByte() && (copy[i + 1].toInt() and 0xFF) in 0xC0..0xC2) {
                copy[i + 5] = (height shr 8).toByte(); copy[i + 6] = height.toByte()
                copy[i + 7] = (width shr 8).toByte(); copy[i + 8] = width.toByte()
                return copy
            }
            i += 2 + (((copy[i + 2].toInt() and 0xFF) shl 8) or (copy[i + 3].toInt() and 0xFF))
        }
        error("no SOF marker")
    }

    /** [jpeg] with an APP1 segment (as EXIF data is carried) that holds [payload] right after SOI. */
    fun withApp1(jpeg: ByteArray, payload: ByteArray): ByteArray {
        val length = payload.size + 2
        val segment = byteArrayOf(0xFF.toByte(), 0xE1.toByte(), (length shr 8).toByte(), length.toByte()) + payload
        return jpeg.copyOfRange(0, 2) + segment + jpeg.copyOfRange(2, jpeg.size)
    }

    private fun forEachNode(node: Node, action: (Node) -> Unit) {
        action(node)
        var child = node.firstChild
        while (child != null) {
            forEachNode(child, action)
            child = child.nextSibling
        }
    }
}
