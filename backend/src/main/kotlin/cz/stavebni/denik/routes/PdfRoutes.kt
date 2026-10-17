package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.services.PdfBusyException
import cz.stavebni.denik.services.PdfExportService
import cz.stavebni.denik.services.PdfUnavailableException
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.services.RateLimiter
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import java.util.UUID

/**
 * The PDF of one report, or the reason there is none. Access has been checked by the caller.
 *
 * Every attempt counts towards the person's limit ([RateLimiter.Rules.PDF_EXPORT]), except an export that the server could not
 * do, busy or without its tool: that is not the person's doing, so the attempt is given back.
 */
private suspend fun ApplicationCall.respondReportPdf(user: SessionUser, reportId: UUID) {
    val attempt = RateLimiter.reserveOrRefuse(DatabaseFactory.dsl, RateLimiter.Rules.PDF_EXPORT, user.id.toString(), "Příliš mnoho exportů do PDF.")
    // A broken or missing PDF tool must be an error the user can see, never an empty "PDF".
    val document = try {
        PdfExportService.generateReportPdf(DatabaseFactory.dsl, reportId)
    } catch (e: PdfUnavailableException) {
        RateLimiter.release(DatabaseFactory.dsl, attempt)
        application.environment.log.error("PDF export is unavailable: ${e.message}")
        respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Export do PDF není na serveru dostupný"))
        return
    } catch (e: PdfBusyException) {
        RateLimiter.release(DatabaseFactory.dsl, attempt)
        // Not an error of the server: come back in a moment.
        response.header(HttpHeaders.RetryAfter, "10")
        respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Export do PDF je právě vytížený, zkuste to za chvíli", "code" to "PDF_BUSY"))
        return
    }

    response.header(HttpHeaders.ContentDisposition, "attachment; filename=\"${document.fileName}\"")
    response.header(HttpHeaders.CacheControl, "private, no-store")
    respondBytes(document.bytes, ContentType.Application.Pdf)
}

fun Application.pdfRoutes() {
    routing {
        authenticate("auth-jwt") {
            // By report id. A date names a day of some project, and dates repeat across projects, so it cannot name a
            // report here: use the project route below for that.
            get("/api/reports/{id}/pdf") {
                val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                val reportId = try {
                    UUID.fromString(call.parameters["id"])
                } catch (e: IllegalArgumentException) {
                    throw IllegalArgumentException("Záznam se určuje svým id; datum jen v rámci projektu (/api/projects/{id}/reports/{datum}/pdf)")
                }
                ProjectAccess.requireReportAccess(DatabaseFactory.dsl, user, reportId)
                call.respondReportPdf(user, reportId)
            }

            // By report id or by day, inside one project: only that project's entries can be found.
            get("/api/projects/{projectId}/reports/{idOrDate}/pdf") {
                val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                val ref = call.parameters["idOrDate"] ?: throw IllegalArgumentException("Chybí id nebo datum záznamu")
                ProjectAccess.requireAccess(DatabaseFactory.dsl, user, projectId)
                val reportId = try {
                    resolveReportId(DatabaseFactory.dsl, ref, projectId)
                } catch (e: NotFoundException) {
                    throw NotFoundException("Záznam nenalezen")
                }
                call.respondReportPdf(user, reportId)
            }
        }
    }
}
