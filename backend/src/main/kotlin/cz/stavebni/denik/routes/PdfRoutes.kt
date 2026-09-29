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
                    val reportUuid = try {
                        UUID.fromString(reportIdStr)
                    } catch (e: Exception) {
                        null
                    }
                    
                    val tx = DatabaseFactory.dsl
                    var report = if (reportUuid != null) {
                        tx.selectFrom(DAILY_REPORTS)
                            .where(DAILY_REPORTS.ID.eq(reportUuid))
                            .and(DAILY_REPORTS.DELETEDAT.isNull)
                            .fetchOne()
                            ?: tx.selectFrom(DAILY_REPORTS)
                                .where(DAILY_REPORTS.PROJECTID.eq(reportUuid))
                                .and(DAILY_REPORTS.DELETEDAT.isNull)
                                .orderBy(DAILY_REPORTS.DATE.desc())
                                .fetchOne()
                    } else {
                        val dateStr = if (reportIdStr.contains("T")) reportIdStr.substringBefore("T") else reportIdStr
                        try {
                            val parsedDate = java.time.OffsetDateTime.parse("${dateStr}T00:00:00Z")
                            tx.selectFrom(DAILY_REPORTS)
                                .where(DAILY_REPORTS.DATE.eq(parsedDate))
                                .and(DAILY_REPORTS.DELETEDAT.isNull)
                                .orderBy(DAILY_REPORTS.CREATEDAT.desc())
                                .fetchOne()
                        } catch (e: Exception) {
                            null
                        }
                    }
                    if (report == null) {
                        throw IllegalArgumentException("Report not found")
                    }
                    val actualReportId = report.get(DAILY_REPORTS.ID)!!
                    
                    val pdfFile = PdfExportService.generateReportPdf(tx, actualReportId)
                    
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
