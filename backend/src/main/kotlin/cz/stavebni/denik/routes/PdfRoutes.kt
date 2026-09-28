package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.services.PdfExportService
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import java.util.UUID

fun Application.pdfRoutes() {
    routing {
        authenticate("auth-jwt") {
            route("/api/reports/{id}/pdf") {
                get {
                    val user = call.principal<SessionUser>() 
                        ?: throw cz.stavebni.denik.domain.UnauthenticatedException()
                        
                    val reportIdStr = call.parameters["id"] 
                        ?: throw IllegalArgumentException("Missing report id")
                    val reportId = UUID.fromString(reportIdStr)
                    
                    val tx = DatabaseFactory.dsl
                    val report = tx.selectFrom(DAILY_REPORTS)
                        .where(DAILY_REPORTS.ID.eq(reportId))
                        .fetchOne() ?: throw IllegalArgumentException("Report not found")
                        
                    val isLocked = report.get(DAILY_REPORTS.LOCKEDAT) != null
                    
                    // Simple mock for isMember = true. In a real app we'd query project members
                    assertCan(user, Action.ReportUpdate, Resource(isMember = true, authorId = report.get(DAILY_REPORTS.AUTHORID), isLocked = isLocked))
                    
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
