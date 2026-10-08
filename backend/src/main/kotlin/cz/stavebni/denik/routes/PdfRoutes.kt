package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.services.PdfExportService
import cz.stavebni.denik.services.PdfUnavailableException
import cz.stavebni.denik.services.ProjectAccess
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Application.pdfRoutes() {
    routing {
        authenticate("auth-jwt") {
            // {id} is a report UUID (preferred) or a YYYY-MM-DD date.
            route("/api/reports/{id}/pdf") {
                get {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportRef = call.parameters["id"] ?: throw IllegalArgumentException("Missing report id")

                    val tx = DatabaseFactory.dsl
                    val reportId = try {
                        resolveReportId(tx, reportRef, null)
                    } catch (e: cz.stavebni.denik.domain.NotFoundException) {
                        throw IllegalArgumentException("Report not found")
                    }
                    ProjectAccess.requireReportAccess(tx, user, reportId)

                    // A broken or missing PDF tool must be an error the user can see, never an empty "PDF".
                    val document = try {
                        PdfExportService.generateReportPdf(tx, reportId)
                    } catch (e: PdfUnavailableException) {
                        call.application.environment.log.error("PDF export is unavailable: ${e.message}")
                        call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Export do PDF není na serveru dostupný"))
                        return@get
                    }

                    call.response.header(HttpHeaders.ContentDisposition, "attachment; filename=\"${document.fileName}\"")
                    call.response.header(HttpHeaders.CacheControl, "private, no-store")
                    call.respondBytes(document.bytes, ContentType.Application.Pdf)
                }
            }
        }
    }
}
