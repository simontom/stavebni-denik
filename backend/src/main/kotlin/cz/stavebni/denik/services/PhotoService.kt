package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.services.AuditService.Audited
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UUIDSerializer
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.records.PhotosRecord
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import net.coobird.thumbnailator.Thumbnails
import org.jooq.DSLContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.math.ceil
import kotlin.math.sqrt
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

/** What the audit log keeps of a photo: ids, sizes and the hashes of the two stored files (text and whole numbers only). */
@Serializable
internal data class PhotoSnapshot(
    val id: String,
    val reportId: String,
    val projectId: String,
    val width: Int,
    val height: Int,
    val bytes: Int,
    val uploadedById: String,
    val sha256Original: String?,
    val sha256Thumbnail: String?,
    val deletedAt: String?,
)

object PhotoService {
    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** Largest accepted upload. The route reads at most this much (+1 byte, to notice an excess). */
    const val MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB
    /** What a JPEG header may claim: a phone photo is 12 to 50 MP. Decoding is reduced below, so this is not what is held in memory. */
    private const val MAX_JPEG_PIXELS = 64_000_000L
    /** Other formats (PNG ...) are decoded in full by the JDK, so they get a smaller limit. */
    private const val MAX_OTHER_PIXELS = 16_000_000L
    private const val MAX_SIDE_PIXELS = 16_000 // longest side; a 1 x 16,000 image is fine, a 1 x 60,000,000 one is not
    /** Most pixels held in memory for one image. The JPEG reader skips pixels while decoding to stay below it. */
    private const val MAX_DECODED_PIXELS = 4_000_000L

    /** Decoding and encoding are heavy: at most two images at the same time, whatever the number of uploads. */
    private val imageSlots = Semaphore(2)

    private class Encoded(val bytes: ByteArray, val width: Int, val height: Int)

    /**
     * Decodes an image, but only after its dimensions were read from the file *header* and checked.
     * A tiny file can claim billions of pixels (a decompression bomb); decoding it first would
     * allocate all of them. A bad header or a failing decoder is a client error, not a server error.
     *
     * A big photo is accepted and decoded already reduced: the reader skips pixels while decoding
     * (source subsampling), so what is held in memory never exceeds about [MAX_DECODED_PIXELS], whatever the
     * size of the original. The stored picture is at most 1920 x 1080 anyway.
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
                    val pixels = width.toLong() * height.toLong()
                    val maxPixels = if (reader.formatName.equals("JPEG", ignoreCase = true)) MAX_JPEG_PIXELS else MAX_OTHER_PIXELS
                    if (pixels > maxPixels || width > MAX_SIDE_PIXELS || height > MAX_SIDE_PIXELS) {
                        throw IllegalArgumentException("Image dimensions exceed ${maxPixels / 1_000_000}MP limit")
                    }
                    val param = reader.defaultReadParam
                    if (pixels > MAX_DECODED_PIXELS) {
                        val step = ceil(sqrt(pixels.toDouble() / MAX_DECODED_PIXELS)).toInt()
                        param.setSourceSubsampling(step, step, 0, 0)
                    }
                    return reader.read(0, param) ?: throw IllegalArgumentException("Invalid or corrupted image data")
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

        // An early, cheap look so that a request that cannot succeed does not make the server decode an image. The
        // decision that counts is made again inside the transaction below, on the locked report row.
        val early = DatabaseFactory.dsl.select(DAILY_REPORTS.PROJECTID, DAILY_REPORTS.LOCKEDAT)
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")
        assertCan(
            user, Action.PhotoUpload,
            Resource(role = ProjectAccess.roleIn(DatabaseFactory.dsl, user.id, early.get(DAILY_REPORTS.PROJECTID)!!), isLocked = early.get(DAILY_REPORTS.LOCKEDAT) != null)
        )

        // 3. Dimensions are checked from the header before any pixel is decoded (max 8 Megapixels);
        //    the image is then decoded exactly once.
        // 4. Re-encoding & sanitization (Airlock: never save raw unvalidated bytes to disk).
        //    Both files are made from the one decoded image. They are fresh JPEGs without metadata, turned upright first:
        //    the camera's orientation lives in the metadata that is thrown away. The work is bounded (two images at a
        //    time) and runs off the request threads.
        val (original, thumbnail) = imageSlots.withPermit {
            withContext(Dispatchers.Default) {
                val decoded = decodeWithinLimits(fileBytes)
                val orientation = if (isJpeg(fileBytes)) ImageOrientation.of(fileBytes) else 1
                val image = if (orientation == 1) decoded else ImageOrientation.apply(decoded, orientation)
                encodeJpeg(image, 1920, 1080) to encodeJpeg(image, 400, 300)
            }
        }

        val fileId = UUID.randomUUID()
        val originalKey = PhotoStorage.keyFor(fileId, thumbnail = false)
        val thumbKey = PhotoStorage.keyFor(fileId, thumbnail = true)
        PhotoStorage.write(originalKey, original.bytes)
        try {
            PhotoStorage.write(thumbKey, thumbnail.bytes)
        } catch (e: Throwable) {
            PhotoStorage.deleteQuietly(originalKey) // no row will ever refer to the first file
            throw e
        }

        val photoId = UUID.randomUUID()
        try {
            return AuditService.auditedWrite(user, "photo") { tx ->
                // The report is locked while the photo is judged and inserted: a report signed while the image was being
                // processed (which took time, outside any lock) is refused here, not silently given a new photo.
                val report = tx.select(DAILY_REPORTS.PROJECTID, DAILY_REPORTS.LOCKEDAT)
                    .from(DAILY_REPORTS)
                    .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
                    .forUpdate()
                    .fetchOne() ?: throw NotFoundException("Záznam nenalezen")
                val projectId = report.get(DAILY_REPORTS.PROJECTID)!!
                assertCan(
                    user, Action.PhotoUpload,
                    Resource(role = ProjectAccess.roleIn(tx, user.id, projectId), isLocked = report.get(DAILY_REPORTS.LOCKEDAT) != null)
                )

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

                // The audit row names the photo and the report, and holds the hashes of both stored files: a swapped file
                // on the volume no longer matches the chain.
                Audited(
                    result = toDto(record),
                    action = "photo.upload",
                    entityId = photoId.toString(),
                    after = Json.encodeToJsonElement(
                        PhotoSnapshot.serializer(),
                        PhotoSnapshot(
                            id = photoId.toString(), reportId = reportId.toString(), projectId = projectId.toString(),
                            width = original.width, height = original.height, bytes = original.bytes.size,
                            uploadedById = user.id.toString(),
                            sha256Original = sha256(original.bytes), sha256Thumbnail = sha256(thumbnail.bytes),
                            deletedAt = null,
                        )
                    ),
                )
            }
        } catch (e: Throwable) {
            // No row was created, so no one will ever reference these files.
            PhotoStorage.deleteQuietly(originalKey)
            PhotoStorage.deleteQuietly(thumbKey)
            throw e
        }
    }

    suspend fun deletePhoto(user: SessionUser, photoId: UUID) {
        AuditService.auditedWrite(user, "photo") { tx ->
            val photo = tx.selectFrom(PHOTOS)
                .where(PHOTOS.ID.eq(photoId).and(PHOTOS.DELETEDAT.isNull))
                .forUpdate()
                .fetchOne() ?: throw IllegalArgumentException("Photo not found")
            val report = tx.select(DAILY_REPORTS.PROJECTID, DAILY_REPORTS.LOCKEDAT)
                .from(DAILY_REPORTS)
                .where(DAILY_REPORTS.ID.eq(photo.get(PHOTOS.REPORTID)))
                .forUpdate()
                .fetchOne() ?: throw IllegalArgumentException("Report not found")
            val projectId = report.get(DAILY_REPORTS.PROJECTID)!!
            assertCan(
                user, Action.PhotoDelete,
                Resource(role = ProjectAccess.roleIn(tx, user.id, projectId), isLocked = report.get(DAILY_REPORTS.LOCKEDAT) != null)
            )

            val now = OffsetDateTime.now()
            tx.update(PHOTOS).set(PHOTOS.DELETEDAT, now).where(PHOTOS.ID.eq(photoId)).execute()
            fun snapshot(deletedAt: String?) = Json.encodeToJsonElement(
                PhotoSnapshot.serializer(),
                PhotoSnapshot(
                    id = photoId.toString(), reportId = photo.get(PHOTOS.REPORTID).toString(), projectId = projectId.toString(),
                    width = photo.get(PHOTOS.WIDTH)!!, height = photo.get(PHOTOS.HEIGHT)!!, bytes = photo.get(PHOTOS.BYTES)!!,
                    uploadedById = photo.get(PHOTOS.UPLOADEDBYID).toString(), sha256Original = null, sha256Thumbnail = null,
                    deletedAt = deletedAt,
                )
            )
            Audited(result = Unit, action = "photo.delete", entityId = photoId.toString(), before = snapshot(null), after = snapshot(now.toString()))
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
