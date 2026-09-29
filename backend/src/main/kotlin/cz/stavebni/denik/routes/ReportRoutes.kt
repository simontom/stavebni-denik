package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.services.DailyReportService
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.UUID

@Serializable
data class CreateReportPayload(
    val date: String? = null,
    val workDescription: String? = null,
    val workerTrade: String? = null,
    val workerCount: String? = null,
    val workersByTrade: String? = null,
    val isControlDay: Boolean? = null,
    val constructionObj: String? = null,
    val signed: Boolean? = null
)

private fun resolveReportId(tx: DSLContext, idOrDate: String, projectIdStr: String?): UUID {
    return try {
        UUID.fromString(idOrDate)
    } catch (e: Exception) {
        val projId = projectIdStr?.let { UUID.fromString(it) }
        val dateStr = if (idOrDate.contains("T")) idOrDate.substringBefore("T") else idOrDate
        val parsedDate = OffsetDateTime.parse("${dateStr}T00:00:00Z")
        val rep = if (projId != null) {
            tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.PROJECTID.eq(projId).and(DAILY_REPORTS.DATE.eq(parsedDate)))
                .fetchOne()
        } else {
            tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.DATE.eq(parsedDate))
                .orderBy(DAILY_REPORTS.CREATEDAT.desc())
                .fetchOne()
        }
        rep?.get(DAILY_REPORTS.ID) ?: throw IllegalArgumentException("Report not found for identifier $idOrDate")
    }
}

fun Application.reportRoutes() {
    routing {
        authenticate("auth-jwt") {
            route("/api/projects/{projectId}/reports") {
                get {
                    call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val projectIdStr = call.parameters["projectId"] ?: throw IllegalArgumentException("Missing projectId")
                    val projectId = UUID.fromString(projectIdStr)
                    val reports = DailyReportService.getReports(projectId)
                    call.respond(reports)
                }

                post {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val projectIdStr = call.parameters["projectId"] ?: throw IllegalArgumentException("Missing projectId")
                    val projectId = UUID.fromString(projectIdStr)
                    val payload = try {
                        call.receive<CreateReportPayload>()
                    } catch (e: Exception) {
                        CreateReportPayload()
                    }

                    val date = payload.date ?: LocalDate.now().toString()
                    val workersByTrade = if (!payload.workersByTrade.isNullOrBlank()) {
                        payload.workersByTrade
                    } else if (!payload.workerTrade.isNullOrBlank()) {
                        "[{\"trade\":\"${payload.workerTrade}\",\"count\":${payload.workerCount ?: "1"}}]"
                    } else {
                        "[]"
                    }

                    val report = DailyReportService.createReport(
                        user = user,
                        projectId = projectId,
                        date = date,
                        workDescription = payload.workDescription ?: "",
                        workersByTrade = workersByTrade,
                        isControlDay = payload.isControlDay ?: false,
                        constructionObj = payload.constructionObj
                    )
                    call.respond(HttpStatusCode.Created, report)
                }

                route("/{reportIdOrDate}") {
                    get {
                        call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val projectIdStr = call.parameters["projectId"] ?: throw IllegalArgumentException("Missing projectId")
                        val reportIdOrDate = call.parameters["reportIdOrDate"] ?: throw IllegalArgumentException("Missing reportIdOrDate")
                        val projectId = UUID.fromString(projectIdStr)
                        val report = DailyReportService.getReport(projectId, reportIdOrDate)
                            ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Report not found"))
                        call.respond(report)
                    }

                    post {
                        val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val projectIdStr = call.parameters["projectId"] ?: throw IllegalArgumentException("Missing projectId")
                        val reportIdOrDate = call.parameters["reportIdOrDate"] ?: throw IllegalArgumentException("Missing reportIdOrDate")
                        val projectId = UUID.fromString(projectIdStr)
                        val payload = try {
                            call.receive<CreateReportPayload>()
                        } catch (e: Exception) {
                            CreateReportPayload()
                        }

                        val date = payload.date ?: reportIdOrDate
                        val workersByTrade = if (!payload.workersByTrade.isNullOrBlank()) {
                            payload.workersByTrade
                        } else if (!payload.workerTrade.isNullOrBlank()) {
                            "[{\"trade\":\"${payload.workerTrade}\",\"count\":${payload.workerCount ?: "1"}}]"
                        } else {
                            "[]"
                        }

                        val report = DailyReportService.createReport(
                            user = user,
                            projectId = projectId,
                            date = date,
                            workDescription = payload.workDescription ?: "",
                            workersByTrade = workersByTrade,
                            isControlDay = payload.isControlDay ?: false,
                            constructionObj = payload.constructionObj
                        )
                        call.respond(HttpStatusCode.OK, report)
                    }

                    post("/sign") {
                        val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val projectIdStr = call.parameters["projectId"]
                        val reportIdOrDate = call.parameters["reportIdOrDate"] ?: throw IllegalArgumentException("Missing reportIdOrDate")
                        val reportId = resolveReportId(DatabaseFactory.dsl, reportIdOrDate, projectIdStr)
                        DailyReportService.signReport(user, reportId)
                        call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                    }

                    post("/acknowledge") {
                        val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val projectIdStr = call.parameters["projectId"]
                        val reportIdOrDate = call.parameters["reportIdOrDate"] ?: throw IllegalArgumentException("Missing reportIdOrDate")
                        val reportId = resolveReportId(DatabaseFactory.dsl, reportIdOrDate, projectIdStr)
                        DailyReportService.acknowledgeReport(user, reportId)
                        call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                    }
                }
            }

            route("/api/reports/{id}") {
                get {
                    call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val id = call.parameters["id"] ?: throw IllegalArgumentException("Missing id")
                    val tx = DatabaseFactory.dsl
                    val reportId = resolveReportId(tx, id, null)
                    val rec = tx.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()
                        ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Report not found"))
                    val report = DailyReportService.getReport(rec.get(DAILY_REPORTS.PROJECTID)!!, reportId.toString())
                    call.respond(report ?: mapOf("status" to "ok"))
                }

                post("/sign") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val id = call.parameters["id"] ?: throw IllegalArgumentException("Missing id")
                    val reportId = resolveReportId(DatabaseFactory.dsl, id, null)
                    DailyReportService.signReport(user, reportId)
                    call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                }

                post("/acknowledge") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val id = call.parameters["id"] ?: throw IllegalArgumentException("Missing id")
                    val reportId = resolveReportId(DatabaseFactory.dsl, id, null)
                    DailyReportService.acknowledgeReport(user, reportId)
                    call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                }
            }
        }
    }
}
