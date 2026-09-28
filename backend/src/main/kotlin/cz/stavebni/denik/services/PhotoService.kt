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

        val report = DatabaseFactory.dsl.select(DAILY_REPORTS.LOCKEDAT)
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")
            
        val isLocked = report.get(DAILY_REPORTS.LOCKEDAT) != null
        
        assertCan(user, Action.PhotoUpload, Resource(isMember = true, isLocked = isLocked))
        
        val thumbStream = ByteArrayOutputStream()
        Thumbnails.of(ByteArrayInputStream(fileBytes))
            .size(1920, 1080)
            .outputFormat("jpg")
            .toOutputStream(thumbStream)
        
        val processedBytes = thumbStream.toByteArray()
        val uploadDir = Paths.get("uploads/photos").apply { 
            if (!Files.exists(this)) Files.createDirectories(this)
        }
        
        val fileId = UUID.randomUUID().toString()
        val originalPath = uploadDir.resolve("${fileId}_orig.jpg")
        val thumbPath = uploadDir.resolve("${fileId}_thumb.jpg")
        
        Files.write(originalPath, fileBytes)
        Files.write(thumbPath, processedBytes)
        
        return AuditService.auditedTransaction(
            actor = user,
            action = "photo.upload",
            entityType = "photo",
            entityId = ""
        ) { tx ->
            val record = tx.insertInto(PHOTOS)
                .set(PHOTOS.ID, org.jooq.impl.DSL.field("uuidv7()", UUID::class.java))
                .set(PHOTOS.REPORTID, reportId)
                .set(PHOTOS.PATHORIGINAL, originalPath.absolutePathString())
                .set(PHOTOS.PATHTHUMB, thumbPath.absolutePathString())
                .set(PHOTOS.WIDTH, 1920)
                .set(PHOTOS.HEIGHT, 1080)
                .set(PHOTOS.BYTES, processedBytes.size)
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
