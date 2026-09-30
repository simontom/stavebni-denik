package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.services.PhotoDto
import cz.stavebni.denik.services.PhotoService
import cz.stavebni.denik.services.ProjectAccess
import kotlinx.serialization.Serializable
import io.ktor.http.*
import io.ktor.http.content.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import java.io.File
import java.util.UUID

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
                val multipart = call.receiveMultipart()
                var fileBytes: ByteArray? = null
                var fileName = "photo.jpg"
                var mimeType = "image/jpeg"
                var reportIdStr: String? = null
                var projectIdStr: String? = null

                multipart.forEachPart { part ->
                    when (part) {
                        is PartData.FileItem -> {
                            fileName = part.originalFileName ?: "photo.jpg"
                            mimeType = part.contentType?.toString() ?: "image/jpeg"
                            fileBytes = part.streamProvider().readBytes()
                        }
                        is PartData.FormItem -> {
                            when (part.name) {
                                "reportId" -> reportIdStr = part.value
                                "projectId" -> projectIdStr = part.value
                            }
                        }
                        else -> {}
                    }
                    part.dispose()
                }

                if (fileBytes == null) {
                    throw IllegalArgumentException("Missing photo file")
                }

                val tx = DatabaseFactory.dsl
                val projectUuid = projectIdStr?.takeIf { it.isNotBlank() }?.let { ProjectAccess.parseId(it, "projectId") }
                val reportUuid: UUID = try {
                    when {
                        !reportIdStr.isNullOrBlank() -> resolveReportId(tx, reportIdStr!!, projectUuid)
                        projectUuid != null -> tx.select(DAILY_REPORTS.ID)
                            .from(DAILY_REPORTS)
                            .where(DAILY_REPORTS.PROJECTID.eq(projectUuid).and(DAILY_REPORTS.DELETEDAT.isNull))
                            .orderBy(DAILY_REPORTS.DATE.desc())
                            .limit(1)
                            .fetchOne()?.value1()
                            ?: throw IllegalArgumentException("No reports found for project $projectIdStr")
                        else -> throw IllegalArgumentException("Missing reportId")
                    }
                } catch (e: Exception) {
                    throw IllegalArgumentException("Invalid report reference: ${e.message}")
                }
                ProjectAccess.requireReportAccess(tx, user, reportUuid)

                val photo = PhotoService.uploadPhoto(
                    user = user,
                    reportId = reportUuid,
                    fileBytes = fileBytes!!,
                    mimeType = mimeType,
                    originalName = fileName
                )

                call.respond(HttpStatusCode.OK, PhotoUploadResponse(
                    status = "ok",
                    id = photo.id.toString(),
                    url = "/api/photos/${photo.id}",
                    name = fileName,
                    photo = photo
                ))
            }
        }

        route("/api/photos/{id}") {
            get {
                val idStr = call.parameters["id"] ?: throw IllegalArgumentException("Missing id")
                val photoId = UUID.fromString(idStr)
                val tx = DatabaseFactory.dsl
                val record = tx.selectFrom(PHOTOS)
                    .where(PHOTOS.ID.eq(photoId).and(PHOTOS.DELETEDAT.isNull))
                    .fetchOne() ?: throw IllegalArgumentException("Photo not found")

                val file = File(record.get(PHOTOS.PATHORIGINAL)!!)
                if (!file.exists()) {
                    call.respond(HttpStatusCode.NotFound)
                    return@get
                }
                call.response.header(HttpHeaders.ContentType, "image/jpeg")
                call.respondFile(file)
            }

            get("/thumb") {
                val idStr = call.parameters["id"] ?: throw IllegalArgumentException("Missing id")
                val photoId = UUID.fromString(idStr)
                val tx = DatabaseFactory.dsl
                val record = tx.selectFrom(PHOTOS)
                    .where(PHOTOS.ID.eq(photoId).and(PHOTOS.DELETEDAT.isNull))
                    .fetchOne() ?: throw IllegalArgumentException("Photo not found")

                val file = File(record.get(PHOTOS.PATHTHUMB)!!)
                if (!file.exists()) {
                    call.respond(HttpStatusCode.NotFound)
                    return@get
                }
                call.response.header(HttpHeaders.ContentType, "image/jpeg")
                call.respondFile(file)
            }
        }
    }
}
