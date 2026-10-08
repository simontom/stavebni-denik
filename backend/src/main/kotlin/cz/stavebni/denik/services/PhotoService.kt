package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UUIDSerializer
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.records.PhotosRecord
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import kotlinx.serialization.Serializable
import net.coobird.thumbnailator.Thumbnails
import org.jooq.DSLContext
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.time.OffsetDateTime
import java.util.UUID
import javax.imageio.ImageIO

@Serializable
data class PhotoDto(
    @Serializable(with = UUIDSerializer::class) val id: UUID,
    @Serializable(with = UUIDSerializer::class) val reportId: UUID,
    val width: Int,
    val height: Int,
    val bytes: Int,
    @Serializable(with = UUIDSerializer::class) val uploadedById: UUID
)

object PhotoService {
    /** Largest accepted upload. The route reads at most this much (+1 byte, to notice an excess). */
    const val MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB
    private const val MAX_PIXELS = 8_000_000L // 8 Megapixels
    private const val MAX_SIDE_PIXELS = 12_000 // longest side; a 1 x 8,000,000 image stays within 8 MP

    private class Encoded(val bytes: ByteArray, val width: Int, val height: Int)

    /**
     * Decodes an image, but only after its dimensions were read from the file *header* and checked.
     * A tiny file can claim billions of pixels (a decompression bomb); decoding it first would
     * allocate all of them. A bad header or a failing decoder is a client error, not a server error.
     */
    private fun decodeWithinLimits(bytes: ByteArray): BufferedImage {
        try {
            ImageIO.createImageInputStream(ByteArrayInputStream(bytes)).use { stream ->
                val readers = ImageIO.getImageReaders(stream)
                if (!readers.hasNext()) throw IllegalArgumentException("Invalid or corrupted image data")
                val reader = readers.next()
                try {
                    reader.setInput(stream, true, true)
                    val width = reader.getWidth(0)
                    val height = reader.getHeight(0)
                    if (width <= 0 || height <= 0) throw IllegalArgumentException("Invalid or corrupted image data")
                    if (width.toLong() * height.toLong() > MAX_PIXELS || width > MAX_SIDE_PIXELS || height > MAX_SIDE_PIXELS) {
                        throw IllegalArgumentException("Image dimensions exceed 8MP limit")
                    }
                    return reader.read(0) ?: throw IllegalArgumentException("Invalid or corrupted image data")
                } finally {
                    reader.dispose()
                }
            }
        } catch (e: IOException) {
            throw IllegalArgumentException("Invalid or corrupted image data")
        }
    }

    /** Scales down to fit [maxWidth] x [maxHeight] (never up) and encodes as a fresh JPEG without any metadata. */
    private fun encodeJpeg(image: BufferedImage, maxWidth: Int, maxHeight: Int): Encoded {
        val scale = minOf(1.0, maxWidth.toDouble() / image.width, maxHeight.toDouble() / image.height)
        val resized = Thumbnails.of(image).scale(scale).asBufferedImage()
        val out = ByteArrayOutputStream()
        Thumbnails.of(resized).scale(1.0).outputFormat("jpg").outputQuality(0.85).toOutputStream(out)
        return Encoded(out.toByteArray(), resized.width, resized.height)
    }

    private fun isJpeg(bytes: ByteArray): Boolean {
        if (bytes.size < 3) return false
        return (bytes[0].toInt() and 0xFF == 0xFF) &&
               (bytes[1].toInt() and 0xFF == 0xD8) &&
               (bytes[2].toInt() and 0xFF == 0xFF)
    }

    private fun isPng(bytes: ByteArray): Boolean {
        if (bytes.size < 8) return false
        return (bytes[0].toInt() and 0xFF == 0x89) &&
               (bytes[1].toInt() and 0xFF == 0x50) &&
               (bytes[2].toInt() and 0xFF == 0x4E) &&
               (bytes[3].toInt() and 0xFF == 0x47)
    }

    private fun isWebp(bytes: ByteArray): Boolean {
        if (bytes.size < 12) return false
        val isRiff = (bytes[0].toInt() and 0xFF == 0x52) &&
                     (bytes[1].toInt() and 0xFF == 0x49) &&
                     (bytes[2].toInt() and 0xFF == 0x46) &&
                     (bytes[3].toInt() and 0xFF == 0x46)
        val isWebp = (bytes[8].toInt() and 0xFF == 0x57) &&
                     (bytes[9].toInt() and 0xFF == 0x45) &&
                     (bytes[10].toInt() and 0xFF == 0x42) &&
                     (bytes[11].toInt() and 0xFF == 0x50)
        return isRiff && isWebp
    }

    private fun validateMagicBytes(bytes: ByteArray): Boolean {
        return isJpeg(bytes) || isPng(bytes) || isWebp(bytes)
    }

    suspend fun uploadPhoto(
        user: SessionUser,
        reportId: UUID,
        fileBytes: ByteArray,
        mimeType: String,
        originalName: String
    ): PhotoDto {
        if (!mimeType.startsWith("image/")) {
            throw IllegalArgumentException("Invalid file format")
        }

        // 1. Byte Size Check (max 5 MB)
        if (fileBytes.size > MAX_UPLOAD_BYTES) {
            throw IllegalArgumentException("File size exceeds 5MB limit")
        }

        // 2. Fast Magic Byte Check (JPEG, PNG, WebP)
        if (!validateMagicBytes(fileBytes)) {
            throw IllegalArgumentException("Invalid image format or magic bytes")
        }

        val report = DatabaseFactory.dsl.select(DAILY_REPORTS.LOCKEDAT)
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")
            
        val isLocked = report.get(DAILY_REPORTS.LOCKEDAT) != null
        
        assertCan(user, Action.PhotoUpload, Resource(isMember = true, isLocked = isLocked))

        // 3. Dimensions are checked from the header before any pixel is decoded (max 8 Megapixels);
        //    the image is then decoded exactly once.
        val image = decodeWithinLimits(fileBytes)

        // 4. Re-encoding & sanitization (Airlock: never save raw unvalidated bytes to disk).
        //    Both files are made from the one decoded image. They are fresh JPEGs without metadata.
        val original = encodeJpeg(image, 1920, 1080)
        val thumbnail = encodeJpeg(image, 400, 300)

        val fileId = UUID.randomUUID()
        val originalKey = PhotoStorage.keyFor(fileId, thumbnail = false)
        val thumbKey = PhotoStorage.keyFor(fileId, thumbnail = true)
        PhotoStorage.write(originalKey, original.bytes)
        PhotoStorage.write(thumbKey, thumbnail.bytes)

        try {
            return AuditService.auditedTransaction(
                actor = user,
                action = "photo.upload",
                entityType = "photo",
                entityId = ""
            ) { tx ->
                val photoId = UUID.randomUUID()
                val record = tx.insertInto(PHOTOS)
                    .set(PHOTOS.ID, photoId)
                    .set(PHOTOS.REPORTID, reportId)
                    .set(PHOTOS.PATHORIGINAL, originalKey)
                    .set(PHOTOS.PATHTHUMB, thumbKey)
                    .set(PHOTOS.WIDTH, original.width)
                    .set(PHOTOS.HEIGHT, original.height)
                    .set(PHOTOS.BYTES, original.bytes.size)
                    .set(PHOTOS.UPLOADEDBYID, user.id)
                    .returning()
                    .fetchOne() ?: throw IllegalStateException("Failed to insert photo")

                toDto(record)
            }
        } catch (e: Throwable) {
            // No row was created, so no one will ever reference these files.
            PhotoStorage.deleteQuietly(originalKey)
            PhotoStorage.deleteQuietly(thumbKey)
            throw e
        }
    }

    suspend fun deletePhoto(user: SessionUser, photoId: UUID) {
        val tx = DatabaseFactory.dsl
        
        val photo = tx.selectFrom(PHOTOS)
            .where(PHOTOS.ID.eq(photoId))
            .fetchOne() ?: throw IllegalArgumentException("Photo not found")
            
        val report = tx.select(DAILY_REPORTS.LOCKEDAT)
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(photo.get(PHOTOS.REPORTID)))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")
            
        val isLocked = report.get(DAILY_REPORTS.LOCKEDAT) != null
        
        assertCan(user, Action.PhotoDelete, Resource(isMember = true, isLocked = isLocked))
        
        AuditService.auditedTransaction(
            actor = user,
            action = "photo.delete",
            entityType = "photo",
            entityId = photoId.toString()
        ) { t ->
            t.update(PHOTOS)
                .set(PHOTOS.DELETEDAT, OffsetDateTime.now())
                .where(PHOTOS.ID.eq(photoId))
                .execute()
        }
    }

    fun listPhotos(tx: DSLContext, reportId: UUID): List<PhotoDto> {
        return tx.selectFrom(PHOTOS)
            .where(PHOTOS.REPORTID.eq(reportId))
            .and(PHOTOS.DELETEDAT.isNull)
            .fetch()
            .map { toDto(it) }
    }

    /** The photo as the API shows it: no file paths, only what a client needs (the image is fetched by id). */
    private fun toDto(record: PhotosRecord) = PhotoDto(
        id = record.get(PHOTOS.ID)!!,
        reportId = record.get(PHOTOS.REPORTID)!!,
        width = record.get(PHOTOS.WIDTH)!!,
        height = record.get(PHOTOS.HEIGHT)!!,
        bytes = record.get(PHOTOS.BYTES)!!,
        uploadedById = record.get(PHOTOS.UPLOADEDBYID)!!
    )
}
