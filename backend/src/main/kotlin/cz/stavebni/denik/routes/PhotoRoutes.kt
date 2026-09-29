package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.services.PhotoDto
import cz.stavebni.denik.services.PhotoService
import kotlinx.serialization.Serializable
import io.ktor.http.*
import io.ktor.http.content.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import java.io.File
import java.time.OffsetDateTime
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
                val reportUuid: UUID = try {
                    if (!reportIdStr.isNullOrBlank()) {
                        try {
                            UUID.fromString(reportIdStr)
                        } catch (e: Exception) {
                            val projUuid = projectIdStr?.let { UUID.fromString(it) }
                            val dateStr = if (reportIdStr!!.contains("T")) reportIdStr!!.substringBefore("T") else reportIdStr!!
                            val parsedDate = OffsetDateTime.parse("${dateStr}T00:00:00Z")
                            val rep = if (projUuid != null) {
                                tx.selectFrom(DAILY_REPORTS)
                                    .where(DAILY_REPORTS.PROJECTID.eq(projUuid))
                                    .and(DAILY_REPORTS.DATE.eq(parsedDate))
                                    .and(DAILY_REPORTS.DELETEDAT.isNull)
                                    .fetchOne()
                            } else null
                            rep?.get(DAILY_REPORTS.ID) ?: throw IllegalArgumentException("Report not found for date $reportIdStr")
                        }
                    } else if (!projectIdStr.isNullOrBlank()) {
                        val projUuid = UUID.fromString(projectIdStr)
                        val latestRep = tx.selectFrom(DAILY_REPORTS)
                            .where(DAILY_REPORTS.PROJECTID.eq(projUuid))
                            .and(DAILY_REPORTS.DELETEDAT.isNull)
                            .orderBy(DAILY_REPORTS.DATE.desc())
                            .fetchOne()
                        latestRep?.get(DAILY_REPORTS.ID) ?: throw IllegalArgumentException("No reports found for project $projectIdStr")
                    } else {
                        val latestRep = tx.selectFrom(DAILY_REPORTS)
                            .where(DAILY_REPORTS.DELETEDAT.isNull)
                            .orderBy(DAILY_REPORTS.CREATEDAT.desc())
                            .fetchOne()
                        latestRep?.get(DAILY_REPORTS.ID) ?: throw IllegalArgumentException("No reports available to attach photo")
                    }
                } catch (e: Exception) {
                    throw IllegalArgumentException("Invalid report reference: ${e.message}")
                }

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
