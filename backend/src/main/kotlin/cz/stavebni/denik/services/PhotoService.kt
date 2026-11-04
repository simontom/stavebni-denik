package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.services.AuditService.Audited
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UUIDSerializer
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.domain.can
import cz.stavebni.denik.jooq.tables.records.PhotosRecord
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import net.coobird.thumbnailator.Thumbnails
import org.jooq.DSLContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import org.slf4j.LoggerFactory
import java.time.Duration
import java.util.UUID
import kotlin.math.ceil
import kotlin.math.sqrt
import javax.imageio.ImageIO
import javax.imageio.ImageReader
import javax.imageio.event.IIOReadUpdateListener

@Serializable
data class PhotoDto(
    @Serializable(with = UUIDSerializer::class) val id: UUID,
    @Serializable(with = UUIDSerializer::class) val reportId: UUID,
    val width: Int,
    val height: Int,
    val bytes: Int,
    @Serializable(with = UUIDSerializer::class) val uploadedById: UUID,
    /**
     * Whether the person who asks may remove this photo right now: **the decision [PhotoService.deletePhoto] makes** (`PhotoDelete` in
     * `Rbac.kt`: the manager of the project any photo of an unsigned entry, a worker the one they uploaded, nobody on a signed entry,
     * nobody who is no member), so the page offers the button exactly when the removal would be accepted. False where the caller is
     * not known (an internal read).
     */
    val canDelete: Boolean = false,
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
    /** The uploader's name as it was at upload (stored with the photo, backlog B9). */
    val uploadedByName: String? = null,
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
    /**
     * What a JPEG that the decoder cannot stream (progressive, or with one scan per component) may claim: it keeps about
     * 6 bytes per pixel for the whole image, measured at 98 MiB for exactly this many pixels
     * (`ProgressiveJpegMemoryTest`). A baseline JPEG is limited by [MAX_JPEG_PIXELS] instead.
     */
    const val MAX_PROGRESSIVE_JPEG_PIXELS = 16_000_000L

    /** Scans a multi-scan JPEG may have. The ordinary progressive script has 10 (3 components); see [JpegHeader] for why. */
    const val MAX_JPEG_SCANS = 32

    /** Components a multi-scan JPEG may have: colour is 3 (6 bytes per pixel kept), a fourth would make it 8. */
    const val MAX_MULTI_SCAN_COMPONENTS = 3

    /**
     * Passes (one per scan of a progressive file, 7 for an interlaced PNG) a decode may make. The header walk caps a JPEG at
     * [MAX_JPEG_SCANS]; this is the same limit enforced **inside the decoder**, for the day the walk and the decoder part ways.
     */
    const val MAX_DECODE_PASSES = 40

    /**
     * How long a decode may take. The worst file the airlock accepts (16 megapixels, 32 scans) takes about 5 s on the
     * development machine; the machine that runs the service is slower, so there is room. Not a way to be slow on purpose:
     * it is the bound for a file that gets past everything above.
     */
    val DECODE_DEADLINE: Duration = Duration.ofSeconds(20)

    /** The three below are variables only so that tests can weaken or tighten them; the real values are the constants above. */
    @Volatile internal var jpegWalker: (ByteArray) -> JpegHeader.Frame? = JpegHeader::frameOf
    @Volatile internal var maxDecodePasses: Int = MAX_DECODE_PASSES
    @Volatile internal var decodeDeadline: Duration = DECODE_DEADLINE
    private const val MAX_SIDE_PIXELS = 16_000 // longest side; a 1 x 16,000 image is fine, a 1 x 60,000,000 one is not
    /** Most pixels held in memory for one image. The JPEG reader skips pixels while decoding to stay below it. */
    private const val MAX_DECODED_PIXELS = 4_000_000L

    /** Decoding and encoding are heavy: at most this many images at the same time, whatever the number of uploads. */
    const val IMAGE_SLOTS = 2
    private val imageSlots = Semaphore(IMAGE_SLOTS)

    private class Encoded(val bytes: ByteArray, val width: Int, val height: Int)

    /** A decode went on for longer than allowed (see [DecodeBound]). A client error: a photo that cannot be decoded in time. */
    private class DecodeBoundException(message: String) : RuntimeException(message)

    /**
     * Throws [DecodeBoundException] when a decode makes more than [maxPasses] passes or has run for more than [deadline].
     * The JDK's reader calls it at the start of every pass (a scan of a progressive file) and after every scanline it
     * delivers, so the check is at most one scanline late, however slow the native decoder is in between.
     */
    private class DecodeBound(private val maxPasses: Int, private val deadline: Duration) : IIOReadUpdateListener {
        private val started = System.nanoTime()
        private var passes = 0

        private fun checkTime() {
            if (System.nanoTime() - started > deadline.toNanos()) {
                throw DecodeBoundException("Image takes longer than ${deadline.toMillis() / 1000.0} s to decode")
            }
        }

        override fun passStarted(source: ImageReader, theImage: BufferedImage?, pass: Int, minPass: Int, maxPass: Int, minX: Int, minY: Int, periodX: Int, periodY: Int, bands: IntArray?) {
            if (++passes > maxPasses) throw DecodeBoundException("Image needs more than $maxPasses passes to decode")
            checkTime()
        }

        override fun imageUpdate(source: ImageReader, theImage: BufferedImage?, minX: Int, minY: Int, width: Int, height: Int, periodX: Int, periodY: Int, bands: IntArray?) = checkTime()
        override fun passComplete(source: ImageReader, theImage: BufferedImage?) {}
        override fun thumbnailPassStarted(source: ImageReader, theThumbnail: BufferedImage?, pass: Int, minPass: Int, maxPass: Int, minX: Int, minY: Int, periodX: Int, periodY: Int, bands: IntArray?) {}
        override fun thumbnailUpdate(source: ImageReader, theThumbnail: BufferedImage?, minX: Int, minY: Int, width: Int, height: Int, periodX: Int, periodY: Int, bands: IntArray?) {}
        override fun thumbnailPassComplete(source: ImageReader, theThumbnail: BufferedImage?) {}
    }

    /**
     * Decodes an image, but only after its dimensions were read from the file *header* and checked.
     * A tiny file can claim billions of pixels (a decompression bomb); decoding it first would
     * allocate all of them. A bad header or a failing decoder is a client error, not a server error.
     *
     * A big photo is accepted and decoded already reduced: the reader skips pixels while decoding
     * (source subsampling), so what is held in memory never exceeds about [MAX_DECODED_PIXELS], whatever the
     * size of the original. The stored picture is at most 1920 x 1080 anyway. That holds for a JPEG the decoder streams;
     * one with several scans (progressive) is limited to [MAX_PROGRESSIVE_JPEG_PIXELS] (see [requireBoundedJpeg]).
     */
    internal fun decodeWithinLimits(bytes: ByteArray): BufferedImage {
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
                    val isJpeg = reader.formatName.equals("JPEG", ignoreCase = true)
                    val maxPixels = if (isJpeg) MAX_JPEG_PIXELS else MAX_OTHER_PIXELS
                    if (pixels > maxPixels || width > MAX_SIDE_PIXELS || height > MAX_SIDE_PIXELS) {
                        throw IllegalArgumentException("Image dimensions exceed ${maxPixels / 1_000_000}MP limit")
                    }
                    if (isJpeg) requireBoundedJpeg(bytes, width, height, pixels)
                    val param = reader.defaultReadParam
                    if (pixels > MAX_DECODED_PIXELS) {
                        val step = ceil(sqrt(pixels.toDouble() / MAX_DECODED_PIXELS)).toInt()
                        param.setSourceSubsampling(step, step, 0, 0)
                    }
                    // The last line of defence (the checks above are the first): the decoder reports every pass and every
                    // scanline, and the bound throws out of those calls when the decode has run too long. An exception out
                    // of a listener stops the native decoder at once; abort() does not (measured: the JDK clears the flag at
                    // the start of each pass, and a one-shot abort from another thread changed nothing).
                    reader.addIIOReadUpdateListener(DecodeBound(maxDecodePasses, decodeDeadline))
                    return try {
                        reader.read(0, param)
                    } catch (e: DecodeBoundException) {
                        throw IllegalArgumentException(e.message)
                    } ?: throw IllegalArgumentException("Invalid or corrupted image data")
                } finally {
                    reader.dispose()
                }
            }
        } catch (e: IOException) {
            throw IllegalArgumentException("Invalid or corrupted image data")
        }
    }

    /**
     * What a JPEG may cost the decoder, decided from the bytes before anything is decoded (see [JpegHeader]). An ordinary
     * single-scan file is streamed and needs neither much memory nor much time, whatever its size. A file with several
     * scans (progressive, or one scan per component) is not:
     *  - the decoder keeps the coefficients of the whole image, about 6 bytes per pixel for 3 components, so it is limited to
     *    [MAX_PROGRESSIVE_JPEG_PIXELS] (373 MiB for the 64 megapixels the header may claim, twice with the decode slots);
     *  - a fourth component costs more again (8 bytes per pixel) and no phone makes such a file: not accepted;
     *  - every scan makes it walk the whole image again and a scan can be a dozen bytes, so more than [MAX_JPEG_SCANS] scans
     *    could keep a native decoder, which cannot be cancelled, busy for hours.
     *
     * The answer comes from our own walk over the file. It must agree with what the decoder reported ([width] and [height]);
     * a file that cannot be followed, or that the two read differently, is refused: when in doubt, not decoded.
     */
    private fun requireBoundedJpeg(bytes: ByteArray, width: Int, height: Int, pixels: Long) {
        val frame = jpegWalker(bytes)
        if (frame == null || frame.width != width || frame.height != height) {
            throw IllegalArgumentException("Invalid or corrupted image data")
        }
        if (!frame.isMultiScan) return
        if (pixels > MAX_PROGRESSIVE_JPEG_PIXELS) {
            throw IllegalArgumentException("Progressive JPEG dimensions exceed ${MAX_PROGRESSIVE_JPEG_PIXELS / 1_000_000}MP limit")
        }
        if (frame.components > MAX_MULTI_SCAN_COMPONENTS) {
            throw IllegalArgumentException("Progressive JPEG with more than $MAX_MULTI_SCAN_COMPONENTS components is not supported")
        }
        if (frame.scans > MAX_JPEG_SCANS) {
            throw IllegalArgumentException("Progressive JPEG with more than $MAX_JPEG_SCANS scans is not supported")
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

    /**
     * Whether [user] may add a photo to the entry right now (their role in its project, and the entry not being signed):
     * one cheap query, no image work. The route asks it **before** the body of the upload is read, so that someone who may not
     * upload is refused without their file being buffered; [uploadPhoto] asks again, and the decision that counts is the one
     * inside its transaction, on the locked row.
     */
    fun requireMayUpload(user: SessionUser, reportId: UUID) {
        val early = DatabaseFactory.dsl.select(DAILY_REPORTS.PROJECTID, DAILY_REPORTS.LOCKEDAT)
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")
        assertCan(
            user, Action.PhotoUpload,
            Resource(role = ProjectAccess.roleIn(DatabaseFactory.dsl, user.id, early.get(DAILY_REPORTS.PROJECTID)!!), isLocked = early.get(DAILY_REPORTS.LOCKEDAT) != null)
        )
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
        requireMayUpload(user, reportId)

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
                val role = ProjectAccess.roleIn(tx, user.id, projectId)
                assertCan(user, Action.PhotoUpload, Resource(role = role, isLocked = report.get(DAILY_REPORTS.LOCKEDAT) != null))

                // Who uploads, as the account says it now: stored with the photo, never changed (backlog B9).
                val uploader = AccountIdentity.of(tx, user.id)
                val record = tx.insertInto(PHOTOS)
                    .set(PHOTOS.ID, photoId)
                    .set(PHOTOS.REPORTID, reportId)
                    .set(PHOTOS.PATHORIGINAL, originalKey)
                    .set(PHOTOS.PATHTHUMB, thumbKey)
                    .set(PHOTOS.WIDTH, original.width)
                    .set(PHOTOS.HEIGHT, original.height)
                    .set(PHOTOS.BYTES, original.bytes.size)
                    // What a signature of the entry covers: the hash of each stored file, as it was when it was stored.
                    .set(PHOTOS.SHA256, sha256(original.bytes))
                    .set(PHOTOS.THUMBSHA256, sha256(thumbnail.bytes))
                    .set(PHOTOS.UPLOADEDBYID, user.id)
                    .set(PHOTOS.UPLOADEDBYNAME, uploader.name)
                    .returning()
                    .fetchOne() ?: throw IllegalStateException("Failed to insert photo")

                // The audit row names the photo and the report, and holds the hashes of both stored files: a swapped file
                // on the volume no longer matches the chain.
                Audited(
                    // The uploader may remove it again (until the entry is signed): the page shows the button at once.
                    result = toDto(record).copy(canDelete = mayDelete(user, role, isLocked = false, uploadedById = user.id)),
                    action = "photo.upload",
                    entityId = photoId.toString(),
                    after = Json.encodeToJsonElement(
                        PhotoSnapshot.serializer(),
                        PhotoSnapshot(
                            id = photoId.toString(), reportId = reportId.toString(), projectId = projectId.toString(),
                            width = original.width, height = original.height, bytes = original.bytes.size,
                            uploadedById = user.id.toString(), uploadedByName = uploader.name,
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

    private val log = LoggerFactory.getLogger(PhotoService::class.java)

    /** The one answer for a photo that is not there, is not the caller's to see, or belongs to a deleted project. "Fotografie", as the dialog that shows it says ("Odebrat fotografii"). */
    private const val PHOTO_NOT_FOUND = "Fotografie nenalezena"

    /**
     * Whether [user], who holds [role] in the project (null: no member), may remove a photo that [uploadedById] uploaded to an entry that is
     * [isLocked] (signed): **the one decision**, made by [deletePhoto] on the locked entry and shown to the page as `canDelete` of every photo.
     */
    fun mayDelete(user: SessionUser, role: Role?, isLocked: Boolean, uploadedById: UUID): Boolean =
        can(user, Action.PhotoDelete, Resource(role = role, isLocked = isLocked, authorId = uploadedById))

    /** [photos] of an entry that [user] reads, each saying whether they may remove it ([mayDelete]); unchanged when the reader is not known. */
    fun withRights(photos: List<PhotoDto>, user: SessionUser?, role: Role?, isLocked: Boolean): List<PhotoDto> =
        if (user == null) photos else photos.map { it.copy(canDelete = mayDelete(user, role, isLocked, it.uploadedById)) }

    /**
     * Removes a photo from an entry that is not signed (backlog A4, the owner's decision of 2026-11-04): the manager of the project may remove
     * any photo, a worker the one they uploaded, nobody else. A signed entry never loses a photo (the database refuses it too, migration V5).
     *
     * Decided inside the transaction, on the **entry row locked FOR UPDATE** (as an upload and a signature do, so a removal and a signature
     * that arrive together are served one after the other: the entry is signed without the photo, or the removal is refused, never a
     * signed entry that loses a photo), and on the caller's role in **that** project:
     *  - a photo that does not exist, belongs to a deleted project, or to a project the caller is no member of (an administrator, who may
     *    read every project, is told "no" instead): 404, the same answer for each, so that photo ids cannot be probed;
     *  - a member who may not remove it (the supervision, the client, a worker and somebody else's photo): 403;
     *  - the entry is signed: 409, in words that say where a correction goes (an addendum).
     *
     * The row is deleted and the audit row (`photo.delete`: the photo as it was stored, with the hashes of both files, and nothing after) is
     * written in the same transaction. **The two files are deleted after it has committed**, only through [PhotoStorage.delete] (a key of the
     * exact shape that resolves inside the uploads directory): a file that cannot be deleted is logged (the key, not a path) and left, an
     * orphan that nothing refers to, and does not undo a removal that has been made.
     */
    suspend fun deletePhoto(user: SessionUser, photoId: UUID) {
        val keys = AuditService.auditedWrite(user, "photo") { tx ->
            // The entry is locked before the photo is judged (the order of an upload: the entry first), whatever else is going on.
            val reportId = tx.select(PHOTOS.REPORTID).from(PHOTOS).where(PHOTOS.ID.eq(photoId).and(PHOTOS.DELETEDAT.isNull))
                .fetchOne(PHOTOS.REPORTID) ?: throw NotFoundException(PHOTO_NOT_FOUND)
            val report = tx.select(DAILY_REPORTS.PROJECTID, DAILY_REPORTS.LOCKEDAT)
                .from(DAILY_REPORTS)
                .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
                .forUpdate()
                .fetchOne() ?: throw NotFoundException(PHOTO_NOT_FOUND)
            // The photo again, now that nothing can add or remove one of this entry: it may have gone while the entry was being waited for.
            val photo = tx.selectFrom(PHOTOS)
                .where(PHOTOS.ID.eq(photoId).and(PHOTOS.DELETEDAT.isNull))
                .forUpdate()
                .fetchOne() ?: throw NotFoundException(PHOTO_NOT_FOUND)
            val projectId = report.get(DAILY_REPORTS.PROJECTID)!!
            if (!tx.fetchExists(PROJECTS, PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))) throw NotFoundException(PHOTO_NOT_FOUND)
            val role = ProjectAccess.roleIn(tx, user.id, projectId)
            if (role == null && !user.isAdmin) throw NotFoundException(PHOTO_NOT_FOUND)
            // Who could never remove it is told that first; only a person who could have removed it learns that the entry is signed.
            assertCan(user, Action.PhotoDelete, Resource(role = role, isLocked = false, authorId = photo.get(PHOTOS.UPLOADEDBYID)))
            if (report.get(DAILY_REPORTS.LOCKEDAT) != null) {
                throw ConflictException("Z podepsaného záznamu nelze fotografii odebrat. Opravu proveďte dodatkem.")
            }

            // What the audit row keeps: the photo as it was stored, hashes of both files included (so the file can still be recognised if a
            // copy of it turns up), and no storage key.
            val before = Json.encodeToJsonElement(
                PhotoSnapshot.serializer(),
                PhotoSnapshot(
                    id = photoId.toString(), reportId = reportId.toString(), projectId = projectId.toString(),
                    width = photo.get(PHOTOS.WIDTH)!!, height = photo.get(PHOTOS.HEIGHT)!!, bytes = photo.get(PHOTOS.BYTES)!!,
                    uploadedById = photo.get(PHOTOS.UPLOADEDBYID).toString(), uploadedByName = photo.get(PHOTOS.UPLOADEDBYNAME),
                    sha256Original = photo.get(PHOTOS.SHA256), sha256Thumbnail = photo.get(PHOTOS.THUMBSHA256),
                    deletedAt = null,
                )
            )
            tx.deleteFrom(PHOTOS).where(PHOTOS.ID.eq(photoId)).execute()
            Audited(
                result = listOf(photo.get(PHOTOS.PATHORIGINAL)!!, photo.get(PHOTOS.PATHTHUMB)!!),
                action = "photo.delete", entityId = photoId.toString(), before = before, after = null,
            )
        }
        // The removal is made and on the record. The files go now, whatever becomes of the request (a client that went away must not leave them).
        withContext(NonCancellable + Dispatchers.IO) {
            for (key in keys) {
                if (!PhotoStorage.delete(key)) {
                    log.warn("A file of a removed photo could not be deleted and is left as an orphan (key {}, photo {})", key, photoId)
                }
            }
        }
    }

    fun listPhotos(tx: DSLContext, reportId: UUID): List<PhotoDto> {
        return tx.selectFrom(PHOTOS)
            .where(PHOTOS.REPORTID.eq(reportId))
            .and(PHOTOS.DELETEDAT.isNull)
            .fetch()
            .map { toDto(it) }
    }

    /** The photos of many reports in ONE query (a list of reports must not ask once per report), keyed by report. */
    fun listPhotosForReports(tx: DSLContext, reportIds: Collection<UUID>): Map<UUID, List<PhotoDto>> {
        if (reportIds.isEmpty()) return emptyMap()
        return tx.selectFrom(PHOTOS)
            .where(PHOTOS.REPORTID.`in`(reportIds))
            .and(PHOTOS.DELETEDAT.isNull)
            .orderBy(PHOTOS.CREATEDAT.asc(), PHOTOS.ID.asc())
            .fetch()
            .groupBy({ it.get(PHOTOS.REPORTID)!! }, { toDto(it) })
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
