package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.TooManyRequestsException
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.services.PhotoDto
import cz.stavebni.denik.services.PhotoService
import cz.stavebni.denik.services.PhotoStorage
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.services.RateLimiter
import cz.stavebni.denik.services.UploadLimits
import kotlinx.serialization.Serializable
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.TimeoutCancellationException

@Serializable
data class PhotoUploadResponse(
    val status: String,
    val id: String,
    val url: String,
    val name: String,
    val photo: PhotoDto
)

fun Application.photoRoutes() {
    routing {
        authenticate("auth-jwt") {
            post("/api/photos/upload") {
                val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                val gate = UploadLimits.gate

                // First stage: an upload in progress, per user, before anything of the body is read. A refused request is
                // answered at once.
                val entered = gate.tryEnter(user.id)
                    ?: throw TooManyRequestsException(UploadLimits.RETRY_AFTER_SECONDS, "Právě se nahrává další vaše fotografie. Počkejte, až skončí, a zkuste to znovu.")
                // Closed on every way out: the answer, an error, a client that went away, a time limit.
                entered.use {
                    // Volume per person, counted before anything is read: every attempt counts, whatever becomes of it.
                    RateLimiter.reserveOrRefuse(DatabaseFactory.dsl, RateLimiter.Rules.PHOTO_UPLOAD, user.id.toString(), "Příliš mnoho nahrávání fotografií.")

                    // Second stage, inside readUpload: the body in memory, for the whole server, taken only for a person who
                    // has been shown to be allowed to add a photo to that entry, and before the file is read.
                    val upload = try {
                        readUpload(call, user, gate)
                    } catch (e: TimeoutCancellationException) {
                        call.respond(HttpStatusCode.RequestTimeout, mapOf("error" to "Nahrávání fotografie trvalo příliš dlouho, zkuste to znovu"))
                        return@post
                    } catch (e: UploadBusyException) {
                        call.response.header(HttpHeaders.RetryAfter, UploadLimits.RETRY_AFTER_SECONDS.toString())
                        call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Server právě přijímá mnoho fotografií, zkuste to za chvíli", "code" to "UPLOAD_BUSY"))
                        return@post
                    }

                    // The body stays in memory until the photo is stored: its permit is given back then.
                    upload.permit.use {
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
