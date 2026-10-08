package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.util.Dates
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.jooq.DSLContext
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
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
    val signed: Boolean? = null,
    /** The `updatedAt` the client last saw; see [DailyReportService.ReportInput.expectedUpdatedAt]. */
    val expectedUpdatedAt: String? = null,
    /** Required when a new entry is for a day before the previous working day (a late entry). */
    val lateEntryReason: String? = null,
    /** The weather, entered by hand; leave it out to keep what is stored, send an empty object to clear it. */
    val weather: cz.stavebni.denik.domain.WeatherData? = null
)

private fun CreateReportPayload.expectedInstant(): OffsetDateTime? =
    expectedUpdatedAt?.takeIf { it.isNotBlank() }?.let {
        try {
            OffsetDateTime.parse(it)
        } catch (e: DateTimeParseException) {
            throw IllegalArgumentException("Neplatná hodnota expectedUpdatedAt")
        }
    }

/**
 * Resolves a report reference that is either a report UUID or a `YYYY-MM-DD`
 * date. Dates are only unique within a project, so without a project the most
 * recently created report of that date is used.
 */
internal fun resolveReportId(tx: DSLContext, idOrDate: String, projectId: UUID?): UUID {
    val asUuid = try {
        UUID.fromString(idOrDate)
    } catch (e: IllegalArgumentException) {
        null
    }
    val condition = if (asUuid != null) {
        DAILY_REPORTS.ID.eq(asUuid)
    } else {
        DAILY_REPORTS.DATE.eq(Dates.parseLocalDate(idOrDate))
    }
    val scoped = if (projectId != null) condition.and(DAILY_REPORTS.PROJECTID.eq(projectId)) else condition
    return tx.select(DAILY_REPORTS.ID)
        .from(DAILY_REPORTS)
        .where(scoped.and(DAILY_REPORTS.DELETEDAT.isNull))
        .orderBy(DAILY_REPORTS.CREATEDAT.desc())
        .limit(1)
        .fetchOne()
        ?.value1()
        ?: throw NotFoundException("Záznam nenalezen: $idOrDate")
}

/** The workers list the request describes, or null when it does not mention workers at all. */
private fun workersJson(payload: CreateReportPayload): String? {
    if (!payload.workersByTrade.isNullOrBlank()) return payload.workersByTrade
    val trade = payload.workerTrade?.trim()
    if (trade == null) return null
    if (trade.isEmpty()) return "[]"
    val count = payload.workerCount?.trim()?.toIntOrNull() ?: 1
    // Built with kotlinx.serialization so user input is always escaped correctly.
    return Json.encodeToString(
        kotlinx.serialization.json.JsonArray.serializer(),
        buildJsonArray {
            add(buildJsonObject {
                put("trade", trade)
                put("count", count)
            })
        }
    )
}

fun Application.reportRoutes() {
    routing {
        authenticate("auth-jwt") {
            route("/api/projects/{projectId}/reports") {
                get {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                    ProjectAccess.requireAccess(DatabaseFactory.dsl, user, projectId)
                    call.respond(DailyReportService.getReports(projectId))
                }

                post {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                    ProjectAccess.requireAccess(DatabaseFactory.dsl, user, projectId)
                    val payload = call.receive<CreateReportPayload>()

                    val report = DailyReportService.createReport(
                        user = user,
                        projectId = projectId,
                        date = payload.date ?: Dates.today(DailyReportService.clock).toString(),
                        workDescription = payload.workDescription ?: "",
                        workersByTrade = workersJson(payload) ?: "[]",
                        isControlDay = payload.isControlDay ?: false,
                        constructionObj = payload.constructionObj,
                        lateEntryReason = payload.lateEntryReason,
                        weather = payload.weather
                    )
                    call.respond(HttpStatusCode.Created, report)
                }

                route("/{reportIdOrDate}") {
                    get {
                        val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                        val reportIdOrDate = call.parameters["reportIdOrDate"] ?: throw IllegalArgumentException("Missing reportIdOrDate")
                        ProjectAccess.requireAccess(DatabaseFactory.dsl, user, projectId)
                        val report = DailyReportService.getReport(projectId, reportIdOrDate)
                            ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Report not found"))
                        call.respond(report)
                    }

                    post {
                        val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                        val reportIdOrDate = call.parameters["reportIdOrDate"] ?: throw IllegalArgumentException("Missing reportIdOrDate")
                        ProjectAccess.requireAccess(DatabaseFactory.dsl, user, projectId)
                        val payload = call.receive<CreateReportPayload>()

                        val report = DailyReportService.saveReport(
                            user = user,
                            projectId = projectId,
                            date = payload.date ?: reportIdOrDate,
                            input = DailyReportService.ReportInput(
                                workDescription = payload.workDescription,
                                workersByTrade = workersJson(payload),
                                isControlDay = payload.isControlDay,
                                constructionObj = payload.constructionObj,
                                expectedUpdatedAt = payload.expectedInstant(),
                                lateEntryReason = payload.lateEntryReason,
                                weather = payload.weather
                            )
                        )
                        call.respond(HttpStatusCode.OK, report)
                    }

                    post("/sign") {
                        val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                        val reportIdOrDate = call.parameters["reportIdOrDate"] ?: throw IllegalArgumentException("Missing reportIdOrDate")
                        ProjectAccess.requireAccess(DatabaseFactory.dsl, user, projectId)
                        val reportId = resolveReportId(DatabaseFactory.dsl, reportIdOrDate, projectId)
                        DailyReportService.signReport(user, reportId)
                        call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                    }

                    post("/acknowledge") {
                        val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                        val reportIdOrDate = call.parameters["reportIdOrDate"] ?: throw IllegalArgumentException("Missing reportIdOrDate")
                        ProjectAccess.requireAccess(DatabaseFactory.dsl, user, projectId)
                        val reportId = resolveReportId(DatabaseFactory.dsl, reportIdOrDate, projectId)
                        DailyReportService.acknowledgeReport(user, reportId)
                        call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                    }
                }
            }

            route("/api/reports/{id}") {
                get {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val tx = DatabaseFactory.dsl
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    val projectId = ProjectAccess.requireReportAccess(tx, user, reportId)
                    val report = DailyReportService.getReport(projectId, reportId.toString())
                        ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Report not found"))
                    call.respond(report)
                }

                post("/sign") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    ProjectAccess.requireReportAccess(DatabaseFactory.dsl, user, reportId)
                    DailyReportService.signReport(user, reportId)
                    call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                }

                post("/acknowledge") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    ProjectAccess.requireReportAccess(DatabaseFactory.dsl, user, reportId)
                    DailyReportService.acknowledgeReport(user, reportId)
                    call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                }
            }
        }
    }
}
