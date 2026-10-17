package cz.stavebni.denik.services

import java.awt.Color
import java.awt.GradientPaint
import java.awt.image.BufferedImage
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
