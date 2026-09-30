package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.services.PdfExportService
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

                    val pdfFile = PdfExportService.generateReportPdf(tx, reportId)

                    call.response.header(
                        HttpHeaders.ContentDisposition,
                        "attachment; filename=\"${pdfFile.name}\""
                    )
                    call.respondFile(pdfFile)
                }
            }
        }
    }
}
