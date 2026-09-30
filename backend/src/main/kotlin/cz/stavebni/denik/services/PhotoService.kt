package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UUIDSerializer
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import kotlinx.serialization.Serializable
import net.coobird.thumbnailator.Thumbnails
import org.jooq.DSLContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Paths
import java.time.OffsetDateTime
import java.util.UUID
import javax.imageio.ImageIO
import kotlin.io.path.absolutePathString

@Serializable
data class PhotoDto(
    @Serializable(with = UUIDSerializer::class) val id: UUID,
    @Serializable(with = UUIDSerializer::class) val reportId: UUID,
    val pathOriginal: String,
    val pathThumb: String,
    val width: Int,
    val height: Int,
    val bytes: Int,
    @Serializable(with = UUIDSerializer::class) val uploadedById: UUID
)

object PhotoService {
    private const val MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB
    private const val MAX_PIXELS = 8_000_000L // 8 Megapixels

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

        // 3. Pixel Count Check (max 8 Megapixels)
        val img = ImageIO.read(ByteArrayInputStream(fileBytes))
            ?: throw IllegalArgumentException("Invalid or corrupted image data")
        if (img.width.toLong() * img.height.toLong() > MAX_PIXELS) {
            throw IllegalArgumentException("Image dimensions exceed 8MP limit")
        }

        // 4. Re-encoding & sanitization (Airlock: never save raw unvalidated bytes to disk)
        val cleanOrigStream = ByteArrayOutputStream()
        Thumbnails.of(ByteArrayInputStream(fileBytes))
            .size(1920, 1080)
            .outputFormat("jpg")
            .toOutputStream(cleanOrigStream)
        val cleanOrigBytes = cleanOrigStream.toByteArray()

        val thumbStream = ByteArrayOutputStream()
        Thumbnails.of(ByteArrayInputStream(fileBytes))
            .size(400, 300)
            .outputFormat("jpg")
            .toOutputStream(thumbStream)
        val processedThumbBytes = thumbStream.toByteArray()

        val uploadDir = cz.stavebni.denik.config.AppConfig.uploadsDir.resolve("photos").apply { 
            if (!Files.exists(this)) Files.createDirectories(this)
        }
        
        val fileId = UUID.randomUUID().toString()
        val originalPath = uploadDir.resolve("${fileId}_orig.jpg")
        val thumbPath = uploadDir.resolve("${fileId}_thumb.jpg")
        
        // Write only sanitized re-encoded JPEG bytes
        Files.write(originalPath, cleanOrigBytes)
        Files.write(thumbPath, processedThumbBytes)
        
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
                .set(PHOTOS.PATHORIGINAL, originalPath.absolutePathString())
                .set(PHOTOS.PATHTHUMB, thumbPath.absolutePathString())
                .set(PHOTOS.WIDTH, img.width.coerceAtMost(1920))
                .set(PHOTOS.HEIGHT, img.height.coerceAtMost(1080))
                .set(PHOTOS.BYTES, cleanOrigBytes.size)
                .set(PHOTOS.UPLOADEDBYID, user.id)
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert photo")
                
            PhotoDto(
                id = record.get(PHOTOS.ID)!!,
                reportId = record.get(PHOTOS.REPORTID)!!,
                pathOriginal = record.get(PHOTOS.PATHORIGINAL)!!,
                pathThumb = record.get(PHOTOS.PATHTHUMB)!!,
                width = record.get(PHOTOS.WIDTH)!!,
                height = record.get(PHOTOS.HEIGHT)!!,
                bytes = record.get(PHOTOS.BYTES)!!,
                uploadedById = record.get(PHOTOS.UPLOADEDBYID)!!
            )
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

    suspend fun listPhotos(tx: DSLContext, reportId: UUID): List<PhotoDto> {
        return tx.selectFrom(PHOTOS)
            .where(PHOTOS.REPORTID.eq(reportId))
            .and(PHOTOS.DELETEDAT.isNull)
            .fetch()
            .map { record ->
                PhotoDto(
                    id = record.get(PHOTOS.ID)!!,
                    reportId = record.get(PHOTOS.REPORTID)!!,
                    pathOriginal = record.get(PHOTOS.PATHORIGINAL)!!,
                    pathThumb = record.get(PHOTOS.PATHTHUMB)!!,
                    width = record.get(PHOTOS.WIDTH)!!,
                    height = record.get(PHOTOS.HEIGHT)!!,
                    bytes = record.get(PHOTOS.BYTES)!!,
                    uploadedById = record.get(PHOTOS.UPLOADEDBYID)!!
                )
            }
    }
}
