package cz.stavebni.denik.services

import java.awt.Color
import java.awt.geom.AffineTransform
import java.awt.image.BufferedImage

/**
 * The orientation a camera recorded in a JPEG's EXIF data (1 to 8). Phones hold the sensor one way and write the way the
 * phone was held into this tag; a viewer that ignores it shows a portrait photo on its side. The photos the app stores are
 * re-encoded without any metadata, so the rotation has to be applied *before* the tag is thrown away.
 */
internal object ImageOrientation {

    /** 1 (upright) when there is no EXIF data, or it is unreadable: a damaged tag must never reject a photo. */
    fun of(jpeg: ByteArray): Int = try {
        read(jpeg)
    } catch (e: IndexOutOfBoundsException) {
        1
    }

    private fun read(b: ByteArray): Int {
        if (b.size < 4 || b[0] != 0xFF.toByte() || b[1] != 0xD8.toByte()) return 1
        var pos = 2
        while (pos + 4 <= b.size) {
            if (b[pos] != 0xFF.toByte()) return 1
            val marker = b[pos + 1].toInt() and 0xFF
            if (marker == 0xD9 || marker == 0xDA) return 1 // end of image / start of pixel data: no metadata follows
            if (marker == 0x01 || marker in 0xD0..0xD8) { // markers without a length
                pos += 2
                continue
            }
            val length = ((b[pos + 2].toInt() and 0xFF) shl 8) or (b[pos + 3].toInt() and 0xFF)
            if (length < 2 || pos + 2 + length > b.size) return 1
            // APP1 holding "Exif\0\0" followed by a TIFF structure
            if (marker == 0xE1 && length >= 8 && b[pos + 4] == 'E'.code.toByte() && b[pos + 5] == 'x'.code.toByte() &&
                b[pos + 6] == 'i'.code.toByte() && b[pos + 7] == 'f'.code.toByte() && b[pos + 8] == 0.toByte() && b[pos + 9] == 0.toByte()
            ) {
                return tiffOrientation(b, pos + 10, pos + 2 + length)
            }
            pos += 2 + length
        }
        return 1
    }

    private fun tiffOrientation(b: ByteArray, start: Int, end: Int): Int {
        if (end - start < 8) return 1
        val little = when {
            b[start] == 'I'.code.toByte() && b[start + 1] == 'I'.code.toByte() -> true
            b[start] == 'M'.code.toByte() && b[start + 1] == 'M'.code.toByte() -> false
            else -> return 1
        }
        fun u16(o: Int): Int =
            if (little) (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8)
            else ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)
        fun u32(o: Int): Long =
            if (little) (u16(o).toLong()) or (u16(o + 2).toLong() shl 16)
            else (u16(o).toLong() shl 16) or u16(o + 2).toLong()

        if (u16(start + 2) != 42) return 1
        val ifd = start + u32(start + 4)
        if (ifd < start || ifd + 2 > end) return 1
        val entries = u16(ifd.toInt())
        for (i in 0 until entries) {
            val entry = ifd.toInt() + 2 + i * 12
            if (entry + 12 > end) return 1
            if (u16(entry) == 0x0112) {
                val value = u16(entry + 8)
                return if (value in 1..8) value else 1
            }
        }
        return 1
    }

    /** The image as it should be seen: rotated and mirrored as the camera asked, on a white background (no alpha). */
    fun apply(image: BufferedImage, orientation: Int): BufferedImage {
        val w = image.width
        val h = image.height
        val swap = orientation in 5..8
        // x' = m00 x + m01 y + m02,  y' = m10 x + m11 y + m12   (AffineTransform takes m00, m10, m01, m11, m02, m12)
        val transform = when (orientation) {
            2 -> AffineTransform(-1.0, 0.0, 0.0, 1.0, w.toDouble(), 0.0)  // mirror horizontally
            3 -> AffineTransform(-1.0, 0.0, 0.0, -1.0, w.toDouble(), h.toDouble()) // rotate 180
            4 -> AffineTransform(1.0, 0.0, 0.0, -1.0, 0.0, h.toDouble())  // mirror vertically
            5 -> AffineTransform(0.0, 1.0, 1.0, 0.0, 0.0, 0.0)            // transpose
            6 -> AffineTransform(0.0, 1.0, -1.0, 0.0, h.toDouble(), 0.0)  // rotate 90 clockwise
            7 -> AffineTransform(0.0, -1.0, -1.0, 0.0, h.toDouble(), w.toDouble()) // transverse
            8 -> AffineTransform(0.0, -1.0, 1.0, 0.0, 0.0, w.toDouble())  // rotate 90 counter-clockwise
            else -> AffineTransform()
        }
        val result = BufferedImage(if (swap) h else w, if (swap) w else h, BufferedImage.TYPE_INT_RGB)
        val g = result.createGraphics()
        try {
            g.color = Color.WHITE
            g.fillRect(0, 0, result.width, result.height)
            g.drawImage(image, transform, null)
        } finally {
            g.dispose()
        }
        return result
    }
}
