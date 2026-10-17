package cz.stavebni.denik.routes

import cz.stavebni.denik.UPLOAD_BODY_LIMIT_BYTES
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.TooManyRequestsException
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.services.PhotoDto
import cz.stavebni.denik.services.PhotoService
import cz.stavebni.denik.services.PhotoStorage
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.services.UploadGate
import cz.stavebni.denik.services.UploadLimits
import kotlinx.serialization.Serializable
import io.ktor.http.*
import io.ktor.http.content.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.utils.io.readRemaining
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.io.readByteArray
import java.io.IOException
import java.util.UUID

@Serializable
data class PhotoUploadResponse(
    val status: String,
    val id: String,
    val url: String,
    val name: String,
    val photo: PhotoDto
)

/** A photo upload has one file and a couple of small text fields. */
private const val MAX_PARTS = 8
private const val MAX_TEXT_FIELD_CHARS = 256

/**
 * Ktor applies this one limit to the body of *every* part, files included, so it cannot be a "small text field"
 * size. It equals the request body limit (see `Application.module()`), which already bounds every part, so the parser
 * never trips over it: the file limit is enforced exactly below and text fields by [MAX_TEXT_FIELD_CHARS]. If it were
 * lower, the parser would fail while we are still answering a 400 for the file, and the client would see a 500.
 */
private const val MULTIPART_PART_LIMIT_BYTES = UPLOAD_BODY_LIMIT_BYTES

/** What the body of an upload held: the one image, and the entry it was authorised for. */
private class Upload(val bytes: ByteArray, val fileName: String, val mimeType: String, val reportId: UUID)

/**
 * Reads the multipart body of an upload. Who may add a photo to which entry is decided **when the file part arrives, before
 * a byte of it is read**, from the fields that came before it (the SPA sends them first): a person who may not upload, or
 * not to that entry, is refused without their file being buffered. A request that sends the file first gets a `400`.
 */
private suspend fun readUpload(call: ApplicationCall, user: SessionUser): Upload {
    val multipart = call.receiveMultipart(formFieldLimit = MULTIPART_PART_LIMIT_BYTES)
    var fileBytes: ByteArray? = null
    var fileName = "photo.jpg"
    var mimeType = "image/jpeg"
    var reportIdStr: String? = null
    var projectIdStr: String? = null
    var reportUuid: UUID? = null
    var partCount = 0

    try {
        multipart.forEachPart { part ->
            if (++partCount > MAX_PARTS) throw IllegalArgumentException("Too many parts in the upload")
            when (part) {
                is PartData.FileItem -> {
                    if (fileBytes != null) throw IllegalArgumentException("Only one photo per upload")
                    reportUuid = authorizeUpload(user, reportIdStr, projectIdStr)
                    fileName = part.originalFileName ?: "photo.jpg"
                    mimeType = part.contentType?.toString() ?: "image/jpeg"
                    // Never hold more than the limit (+1 byte, to notice an excess) in memory. The read suspends instead of
                    // blocking a thread, so a slow sender holds no thread, and it is cancelled by the time limit of the upload.
                    val bytes = part.provider().readRemaining(PhotoService.MAX_UPLOAD_BYTES + 1L).readByteArray()
                    if (bytes.size > PhotoService.MAX_UPLOAD_BYTES) throw IllegalArgumentException("File size exceeds 5MB limit")
                    fileBytes = bytes
                }
                is PartData.FormItem -> {
                    if (part.value.length > MAX_TEXT_FIELD_CHARS) throw IllegalArgumentException("Form field '${part.name}' is too long")
                    when (part.name) {
                        "reportId" -> reportIdStr = part.value
                        "projectId" -> projectIdStr = part.value
                    }
                }
                else -> {}
            }
            part.dispose()
        }
    } catch (e: IOException) {
        // The multipart parser's own failures (a part over its limit, a broken body) are the client's fault.
        throw IllegalArgumentException("Invalid upload: send one image of at most 5MB as multipart/form-data")
    }

    val bytes = fileBytes ?: throw IllegalArgumentException("Missing photo file")
    return Upload(bytes, fileName, mimeType, reportUuid!!)
}

/**
 * The entry a photo is for, and the check that [user] may add one to it: member of the project (or administrator), a role
 * that may upload, the entry not signed. All of it from one or two cheap queries, so it can run before the file is read.
 */
private fun authorizeUpload(user: SessionUser, reportIdStr: String?, projectIdStr: String?): UUID {
    val tx = DatabaseFactory.dsl
    val projectUuid = projectIdStr?.takeIf { it.isNotBlank() }?.let { ProjectAccess.parseId(it, "projectId") }
    // The photo belongs to the entry the client names. No guessing ("the newest entry of the project" put photos
    // on the wrong day), and a bare date needs the project it is in (dates repeat across projects).
    val reportRef = reportIdStr?.trim().orEmpty()
    if (reportRef.isEmpty()) {
        throw IllegalArgumentException("Chybí reportId: fotografii lze přidat jen k uloženému záznamu. Pole reportId (a projectId) musí v požadavku předcházet souboru")
    }
    val isUuid = runCatching { UUID.fromString(reportRef) }.isSuccess
    if (!isUuid && projectUuid == null) throw IllegalArgumentException("Datum záznamu je nutné zadat spolu s projectId")
    val reportUuid: UUID = try {
        resolveReportId(tx, reportRef, projectUuid)
    } catch (e: NotFoundException) {
        throw e
    } catch (e: IllegalArgumentException) {
        // Only the client's mistake is told; nothing the database or a library said is passed on.
        throw IllegalArgumentException("Neplatný odkaz na záznam")
    }
    ProjectAccess.requireReportAccess(tx, user, reportUuid)
    PhotoService.requireMayUpload(user, reportUuid)
    return reportUuid
}

fun Application.photoRoutes() {
    routing {
        authenticate("auth-jwt") {
            post("/api/photos/upload") {
                val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()

                // The body of an upload is held in memory from its first byte. So the number of bodies in flight is bounded,
                // per user and for the server, BEFORE the body is touched; a refused request is answered at once.
                val permit = when (val admission = UploadLimits.gate.tryAcquire(user.id)) {
                    is UploadGate.Permit -> admission
                    UploadGate.Refusal.USER_BUSY ->
                        throw TooManyRequestsException(UploadLimits.RETRY_AFTER_SECONDS, "Právě se nahrává další vaše fotografie. Počkejte, až skončí, a zkuste to znovu.")
                    UploadGate.Refusal.SERVER_BUSY -> {
                        call.response.header(HttpHeaders.RetryAfter, UploadLimits.RETRY_AFTER_SECONDS.toString())
                        call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Server právě přijímá mnoho fotografií, zkuste to za chvíli", "code" to "UPLOAD_BUSY"))
                        return@post
                    }
                }
                // Closed on every way out: the answer, an error, a client that went away, the time limit.
                permit.use {
                    val upload = try {
                        withTimeout(UploadLimits.bodyTimeout.toMillis()) { readUpload(call, user) }
                    } catch (e: TimeoutCancellationException) {
                        call.respond(HttpStatusCode.RequestTimeout, mapOf("error" to "Nahrávání fotografie trvalo příliš dlouho, zkuste to znovu"))
                        return@post
                    }

                    val photo = PhotoService.uploadPhoto(
                        user = user,
                        reportId = upload.reportId,
                        fileBytes = upload.bytes,
                        mimeType = upload.mimeType,
                        originalName = upload.fileName
                    )

                    call.respond(HttpStatusCode.OK, PhotoUploadResponse(
                        status = "ok",
                        id = photo.id.toString(),
                        url = "/api/photos/${photo.id}",
                        name = upload.fileName,
                        photo = photo
                    ))
                }
            }

            // Photos are evidence from the site: only logged-in members of the
            // report's project (and app admins) may download them.
            route("/api/photos/{id}") {
                get { call.respondPhoto(thumbnail = false) }
                get("/thumb") { call.respondPhoto(thumbnail = true) }
            }
        }
    }
}

/**
 * Sends the original (or the thumbnail) of a photo to a user who may see its
 * report. A photo the caller may not see is answered with 404, exactly like a
 * missing one, so photo ids cannot be probed.
 */
private suspend fun ApplicationCall.respondPhoto(thumbnail: Boolean) {
    val user = principal<SessionUser>() ?: throw UnauthenticatedException()
    val photoId = ProjectAccess.parseId(parameters["id"], "photo id")
    val tx = DatabaseFactory.dsl
    val record = tx.selectFrom(PHOTOS)
        .where(PHOTOS.ID.eq(photoId).and(PHOTOS.DELETEDAT.isNull))
        .fetchOne() ?: throw NotFoundException("Fotka nenalezena")

    try {
        ProjectAccess.requireReportAccess(tx, user, record.get(PHOTOS.REPORTID)!!)
    } catch (e: ForbiddenException) {
        throw NotFoundException("Fotka nenalezena")
    }

    // The database holds a storage key; it is only followed when it is well-formed and stays inside the uploads directory.
    val file = PhotoStorage.resolve(record.get(if (thumbnail) PHOTOS.PATHTHUMB else PHOTOS.PATHORIGINAL)!!)
        ?: throw NotFoundException("Fotka nenalezena")

    response.header(HttpHeaders.ContentType, "image/jpeg")
    // Evidence photos: the browser may keep one but has to ask again, so a logout or a lost membership takes effect.
    response.header(HttpHeaders.CacheControl, "private, no-cache")
    respondFile(file.toFile())
}
