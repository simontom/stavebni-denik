package cz.stavebni.denik.routes

import cz.stavebni.denik.UPLOAD_BODY_LIMIT_BYTES
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.services.PhotoService
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.services.UploadGate
import cz.stavebni.denik.services.UploadLimits
import io.ktor.http.*
import io.ktor.http.cio.MultipartEvent
import io.ktor.http.cio.parseMultipart
import io.ktor.server.application.*
import io.ktor.server.plugins.PayloadTooLargeException
import io.ktor.server.request.*
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.readRemaining
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.withTimeout
import kotlinx.io.readByteArray
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.TimeSource
import kotlin.time.toKotlinDuration

/** A photo upload has one file and a couple of small text fields. */
private const val MAX_PARTS = 8
private const val MAX_TEXT_FIELD_CHARS = 256

/** The most bytes a text field of [MAX_TEXT_FIELD_CHARS] characters can take (UTF-8, 4 bytes at most per character). */
private const val MAX_TEXT_FIELD_BYTES = MAX_TEXT_FIELD_CHARS * 4

/**
 * The most the parser lets one part be. The whole request is already bounded by the request limit (`Application.module()`), so
 * no part can pass it; the file limit is enforced exactly below and text fields by [MAX_TEXT_FIELD_CHARS].
 */
private const val MULTIPART_PART_LIMIT_BYTES = UPLOAD_BODY_LIMIT_BYTES

/** What a client is told about any multipart body that is not one: never what it sent, never what the parser said. */
private const val INVALID_UPLOAD = "Neplatný požadavek: pošlete jednu fotografii (nejvýše 5 MB) jako multipart/form-data"

/**
 * What the body of an upload held: the one image, the entry it was authorised for, and the [permit] that counts its memory
 * (the second stage of [UploadGate]). The caller closes the permit when it is done with [bytes].
 */
internal class Upload(val bytes: ByteArray, val fileName: String, val mimeType: String, val reportId: UUID, val permit: UploadGate.Permit)

/** The server holds all the upload bodies it may; this one has to wait. Answered `503` by the route. */
internal class UploadBusyException : RuntimeException("all upload bodies in flight are taken")

/**
 * Anything the multipart parser throws is a malformed request, and is answered `400` with [INVALID_UPLOAD]: a missing or
 * over-long boundary, a part header without a colon or without a value, a body that ends in the middle. What it must not turn
 * into is a 500 with a stack trace, or a 409 that repeats the parser's message with the client's own text in it. Two things
 * are not the parser's: a body that grew past the request limit (a 413) and a cancellation (the deadlines, a client that left).
 */
private fun malformed(cause: Throwable): Throwable =
    if (cause is PayloadTooLargeException || cause is CancellationException || cause !is Exception) cause
    else IllegalArgumentException(INVALID_UPLOAD)

private inline fun <T> parsing(block: () -> T): T = try { block() } catch (e: Throwable) { throw malformed(e) }

/**
 * Reads the multipart body of an upload as a **stream**, so that nothing is held in memory before the person is known to
 * be allowed to upload:
 *
 * - the text fields are read with a limit of a few hundred bytes (what comes after is dropped as it arrives, never buffered);
 * - **when the file part arrives, before its first byte is read,** the entry is found from the fields that came before it
 *   (the SPA sends them first; a file that comes first is a `400`) and the person's right to add a photo to it is checked.
 *   An investor, an inspector or a stranger is refused here, with nothing of their file held;
 * - only then a place for the body in memory is taken ([UploadGate.tryTakeBody]), and the file is read, at most 5 MiB.
 *
 * Two deadlines apply, [UploadLimits.preFileTimeout] up to that point and [UploadLimits.bodyTimeout] (counted from the start)
 * for the file. A [kotlinx.coroutines.TimeoutCancellationException] is the route's to answer with `408`.
 *
 * The parser is Ktor's own (`parseMultipart`), run under a supervisor so that a broken body arrives here as an exception to
 * answer, and does not cancel the call. The supervisor is a child of the call that never completes by itself: **everything
 * from its creation is inside the `try`**, so that it is cancelled however this function ends (a boundary the parser
 * refuses throws before it has returned anything).
 */
internal suspend fun readUpload(call: ApplicationCall, user: SessionUser, gate: UploadGate): Upload {
    val contentType = call.request.contentType()
    if (!contentType.match(ContentType.MultiPart.FormData)) throw IllegalArgumentException(INVALID_UPLOAD)

    val started = TimeSource.Monotonic.markNow()
    var bodyPermit: UploadGate.Permit? = null
    /** Until the file part is authorised the short deadline applies, afterwards the one for the whole upload. */
    fun remaining() =
        (if (bodyPermit == null) UploadLimits.preFileTimeout else UploadLimits.bodyTimeout).toKotlinDuration() - started.elapsedNow()
    suspend fun <T> within(block: suspend () -> T): T = withTimeout(remaining().coerceAtLeast(0.milliseconds)) { block() }

    var supervisor: CompletableJob? = null
    var events: ReceiveChannel<MultipartEvent>? = null
    try {
        supervisor = SupervisorJob(call.coroutineContext[Job])
        val parser = parsing {
            CoroutineScope(call.coroutineContext + supervisor).parseMultipart(call.receiveChannel(), contentType.toString(), call.request.contentLength(), MULTIPART_PART_LIMIT_BYTES)
        }
        events = parser
        var fileBytes: ByteArray? = null
        var fileName = "photo.jpg"
        var mimeType = "image/jpeg"
        var reportIdStr: String? = null
        var projectIdStr: String? = null
        var reportUuid: UUID? = null
        var partCount = 0

        while (true) {
            val received = within { parser.receiveCatching() }
            if (received.isClosed) {
                received.exceptionOrNull()?.let { throw malformed(it) }
                break
            }
            val event = received.getOrThrow()
            if (event !is MultipartEvent.MultipartPart) {
                parsing { event.releaseSuspend() }
                continue
            }
            if (++partCount > MAX_PARTS) throw IllegalArgumentException("Too many parts in the upload")

            val headers = within { parsing { event.headers.await() } }
            val disposition = parsing { headers["Content-Disposition"]?.toString()?.let { ContentDisposition.parse(it) } }
            val name = disposition?.parameter("name")
            val filename = disposition?.parameter("filename")
            if (filename == null) {
                val value = within { readText(event.body, name) }
                when (name) {
                    "reportId" -> reportIdStr = value
                    "projectId" -> projectIdStr = value
                }
            } else {
                if (fileBytes != null) throw IllegalArgumentException("Only one photo per upload")
                reportUuid = authorizeUpload(user, reportIdStr, projectIdStr)
                bodyPermit = gate.tryTakeBody() ?: throw UploadBusyException()
                fileName = filename
                mimeType = headers["Content-Type"]?.toString() ?: "image/jpeg"
                // Never hold more than the limit (+1 byte, to notice an excess) in memory. The read suspends instead of
                // blocking a thread, and the time limit of the upload cancels it.
                val bytes = within { parsing { event.body.readRemaining(PhotoService.MAX_UPLOAD_BYTES + 1L).readByteArray() } }
                if (bytes.size > PhotoService.MAX_UPLOAD_BYTES) throw IllegalArgumentException("File size exceeds 5MB limit")
                fileBytes = bytes
            }
            parsing { event.releaseSuspend() }
        }
        val bytes = fileBytes ?: throw IllegalArgumentException("Missing photo file")
        return Upload(bytes, fileName, mimeType, reportUuid!!, bodyPermit!!)
    } catch (t: Throwable) {
        bodyPermit?.close()
        throw t
    } finally {
        events?.cancel() // a no-op when the body was read to its end; otherwise it stops the parser
        supervisor?.cancel()
    }
}

/** A text field, at most [MAX_TEXT_FIELD_CHARS] characters. What follows in a longer one is never read into memory. */
private suspend fun readText(body: ByteReadChannel, name: String?): String {
    val bytes = parsing { body.readRemaining(MAX_TEXT_FIELD_BYTES + 1L).readByteArray() }
    val text = if (bytes.size > MAX_TEXT_FIELD_BYTES) null else bytes.decodeToString()
    if (text == null || text.length > MAX_TEXT_FIELD_CHARS) throw IllegalArgumentException("Form field '$name' is too long")
    return text
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
