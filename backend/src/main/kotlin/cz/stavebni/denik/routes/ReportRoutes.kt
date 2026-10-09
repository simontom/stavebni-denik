package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.services.AddendumService
import cz.stavebni.denik.services.CreateAddendumRequest
import cz.stavebni.denik.services.CreateRemarkRequest
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.services.RemarkService
import cz.stavebni.denik.services.ReportSignature
import cz.stavebni.denik.services.SigningGuard
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
    /** Set by a client that loaded the form for a day without an entry: refused (409 STALE_VERSION) if one exists by now. */
    val expectNew: Boolean? = null,
    /** Required when a new entry is for a day before the previous working day (a late entry). */
    val lateEntryReason: String? = null,
    /** The weather, entered by hand; leave it out to keep what is stored, send an empty object to clear it. */
    val weather: cz.stavebni.denik.domain.WeatherData? = null,
    /** The text fields of [cz.stavebni.denik.services.EntryDetails] by key; leave a key out to keep what is stored, send an empty text to clear it. */
    val details: Map<String, String>? = null
)

/**
 * The body of a sign request: the version of the entry the signer was looking at (optional) and the signer's password
 * (required: signing asks for it again, decision D8).
 */
@Serializable
private data class SignPayload(val expectedUpdatedAt: String? = null, val password: String? = null)

private class SignRequest(val expectedUpdatedAt: OffsetDateTime?, val password: String?)

/** The sign request's body. A body that is not valid JSON is a 400, like everywhere else. */
private suspend fun ApplicationCall.receiveSignRequest(): SignRequest {
    val text = receiveText()
    if (text.isBlank()) return SignRequest(null, null)
    val payload = Json { ignoreUnknownKeys = true }.decodeFromString(SignPayload.serializer(), text)
    val version = payload.expectedUpdatedAt?.takeIf { it.isNotBlank() }?.let {
        try {
            OffsetDateTime.parse(it)
        } catch (e: DateTimeParseException) {
            throw IllegalArgumentException("Neplatná hodnota expectedUpdatedAt")
        }
    }
    return SignRequest(version, payload.password)
}

/**
 * Signs entry [reportId] for [user]: first whether they may sign it at all (so that someone who cannot is told so rather than
 * asked for a password), then the password, then the signature in one transaction with the audit row.
 */
private suspend fun ApplicationCall.signReport(user: SessionUser, reportId: UUID) {
    val request = receiveSignRequest()
    DailyReportService.checkMaySign(user, reportId)
    SigningGuard.confirmPassword(user, request.password)
    DailyReportService.signReport(user, reportId, request.expectedUpdatedAt)
    respond(HttpStatusCode.OK, mapOf("status" to "ok"))
}

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
    val count = payload.workerCount?.trim()?.takeIf { it.isNotEmpty() }?.toIntOrNull()
        ?: throw IllegalArgumentException("Zadejte počet pracovníků u profese '$trade' (celé číslo)")
    require(count >= 0) { "Počet pracovníků u profese '$trade' nemůže být záporný" }
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
                    val limit = call.request.queryParameters["limit"]?.let { it.toIntOrNull() ?: throw IllegalArgumentException("limit musí být celé číslo") }
                        ?: DailyReportService.DEFAULT_PAGE_SIZE
                    val offset = call.request.queryParameters["offset"]?.let { it.toIntOrNull() ?: throw IllegalArgumentException("offset musí být celé číslo") } ?: 0
                    val page = DailyReportService.getReports(projectId, limit, offset)
                    // The body stays a plain list; how many entries the project has in all is in a header.
                    call.response.header("X-Total-Count", page.total.toString())
                    call.respond(page.reports)
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
                        weather = payload.weather,
                        details = payload.details,
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
                                weather = payload.weather,
                                details = payload.details,
                                expectNew = payload.expectNew == true
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
                        call.signReport(user, reportId)
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
                    call.signReport(user, reportId)
                }

                // Who signed, and whether the entry and its photos are still what was signed.
                get("/signature") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    ProjectAccess.requireReportAccess(DatabaseFactory.dsl, user, reportId)
                    call.respond(ReportSignature.check(DatabaseFactory.dsl, reportId))
                }

                post("/acknowledge") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    ProjectAccess.requireReportAccess(DatabaseFactory.dsl, user, reportId)
                    DailyReportService.acknowledgeReport(user, reportId)
                    call.respond(HttpStatusCode.OK, mapOf("status" to "ok"))
                }

                // Addenda: how a signed entry is corrected or completed (append-only).
                get("/addenda") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    call.respond(AddendumService.list(DatabaseFactory.dsl, user, reportId))
                }

                post("/addenda") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    ProjectAccess.requireReportAccess(DatabaseFactory.dsl, user, reportId)
                    val request = call.receive<CreateAddendumRequest>()
                    call.respond(HttpStatusCode.Created, AddendumService.create(user, reportId, request))
                }

                // Entries of other parties (technical supervision, the client, authorities via the manager): append-only.
                get("/remarks") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    call.respond(RemarkService.list(DatabaseFactory.dsl, user, reportId))
                }

                post("/remarks") {
                    val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val reportId = ProjectAccess.parseId(call.parameters["id"], "reportId")
                    ProjectAccess.requireReportAccess(DatabaseFactory.dsl, user, reportId)
                    val request = call.receive<CreateRemarkRequest>()
                    call.respond(HttpStatusCode.Created, RemarkService.create(user, reportId, request))
                }
            }
        }
    }
}
