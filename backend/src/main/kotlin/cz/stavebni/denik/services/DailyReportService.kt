package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.domain.can
import cz.stavebni.denik.jooq.tables.records.DailyReportsRecord
import cz.stavebni.denik.jooq.tables.references.*
import cz.stavebni.denik.services.AuditService.Audited
import cz.stavebni.denik.util.Dates
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.jooq.DSLContext
import org.jooq.JSONB
import java.time.OffsetDateTime
import java.util.UUID

@Serializable
data class DailyReportDto(
    val id: String,
    val projectId: String,
    val date: String,
    val weather: WeatherData? = null,
    val generalNotes: String? = null,
    val isLocked: Boolean = false,
    val workDescription: String = "",
    val workersByTrade: String = "[]",
    val isControlDay: Boolean = false,
    val constructionObj: String? = null,
    val isSigned: Boolean = false,
    val isAcknowledged: Boolean = false,
    val photos: List<PhotoDto> = emptyList()
)

/**
 * What the audit log keeps of a report before and after a change.
 *
 * Built from database rows only, so every value is exactly what is stored. It holds
 * strings, booleans and whole numbers only (the workers list stays a JSON *string*):
 * no decimals, whose textual form could change on the way through jsonb and break
 * the hash chain.
 */
@Serializable
internal data class ReportSnapshot(
    val id: String,
    val projectId: String,
    val date: String,
    val sequenceNumber: Int,
    val authorId: String,
    val workDescription: String,
    val workersByTrade: String,
    val isControlDay: Boolean,
    val constructionObj: String?,
    val signedAt: String?,
    val signedById: String?,
    val lockedAt: String?,
    val acknowledgedAt: String?,
    val acknowledgedById: String?,
)

object DailyReportService {

    /**
     * Creates the report of a day, or overwrites it while it is still unsigned.
     *
     * Everything that depends on the current state (does the report exist, is it
     * signed, is the caller really a member of the project) is decided inside the
     * audited transaction, on a row locked `FOR UPDATE`.
     */
    suspend fun createReport(
        user: SessionUser,
        projectId: UUID,
        date: String,
        workDescription: String = "",
        workersByTrade: String = "[]",
        isControlDay: Boolean = false,
        constructionObj: String? = null
    ): DailyReportDto {
        val parsedDate = Dates.parseLocalDate(date)
        val workers = JSONB.valueOf(workersByTrade.ifBlank { "[]" })

        return AuditService.auditedWrite(user, "report") { tx ->
            if (!tx.fetchExists(PROJECTS, PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))) {
                throw NotFoundException("Projekt nenalezen")
            }
            // Real membership: an app admin who is not a member of the project may read it, not write to it.
            assertCan(user, Action.ReportCreate, Resource(isMember = ProjectAccess.isMember(tx, user.id, projectId)))

            val existing = tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.PROJECTID.eq(projectId))
                .and(DAILY_REPORTS.DATE.eq(parsedDate))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .forUpdate()
                .fetchOne()

            if (existing == null) {
                val nextSeq = tx.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)) + 1
                val created = tx.insertInto(DAILY_REPORTS)
                    .set(DAILY_REPORTS.PROJECTID, projectId)
                    .set(DAILY_REPORTS.AUTHORID, user.id)
                    .set(DAILY_REPORTS.DATE, parsedDate)
                    .set(DAILY_REPORTS.SEQUENCENUMBER, nextSeq)
                    .set(DAILY_REPORTS.WORKERSBYTRADE, workers)
                    .set(DAILY_REPORTS.WORKDESCRIPTION, workDescription)
                    .set(DAILY_REPORTS.ISCONTROLDAY, isControlDay)
                    .set(DAILY_REPORTS.CONSTRUCTIONOBJ, constructionObj)
                    .returning()
                    .fetchOne() ?: throw IllegalStateException("Failed to insert report")

                Audited(
                    result = toDto(created, emptyList()),
                    action = "report.create",
                    entityId = created.id.toString(),
                    after = created.toSnapshot(),
                )
            } else {
                if (existing.lockedat != null) {
                    throw ConflictException("Záznam je podepsán a uzamčen, nelze jej měnit")
                }
                val updated = tx.update(DAILY_REPORTS)
                    .set(DAILY_REPORTS.WORKDESCRIPTION, workDescription)
                    .set(DAILY_REPORTS.WORKERSBYTRADE, workers)
                    .set(DAILY_REPORTS.ISCONTROLDAY, isControlDay)
                    .set(DAILY_REPORTS.CONSTRUCTIONOBJ, constructionObj)
                    .set(DAILY_REPORTS.UPDATEDAT, OffsetDateTime.now())
                    .where(DAILY_REPORTS.ID.eq(existing.id).and(DAILY_REPORTS.LOCKEDAT.isNull))
                    .returning()
                    .fetchOne() ?: throw ConflictException("Záznam je podepsán a uzamčen, nelze jej měnit")

                Audited(
                    result = toDto(updated, PhotoService.listPhotos(tx, updated.id!!)),
                    action = "report.update",
                    entityId = updated.id.toString(),
                    before = existing.toSnapshot(),
                    after = updated.toSnapshot(),
                )
            }
        }
    }

    suspend fun getReports(projectId: UUID): List<DailyReportDto> {
        val tx = DatabaseFactory.dsl
        val records = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.PROJECTID.eq(projectId))
            .and(DAILY_REPORTS.DELETEDAT.isNull)
            .orderBy(DAILY_REPORTS.DATE.desc())
            .fetch()

        return records.mapNotNull { record ->
            val reportId = record.id ?: return@mapNotNull null
            toDto(record, PhotoService.listPhotos(tx, reportId))
        }
    }

    /**
     * A report of [projectId], addressed by its id or its day (`YYYY-MM-DD`).
     * A report id that belongs to another project is "not found", not readable
     * through this project.
     */
    suspend fun getReport(projectId: UUID, reportIdOrDate: String): DailyReportDto? {
        val tx = DatabaseFactory.dsl
        val uuid = try {
            UUID.fromString(reportIdOrDate)
        } catch (e: IllegalArgumentException) {
            null
        }
        val record = if (uuid != null) {
            tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.ID.eq(uuid))
                .and(DAILY_REPORTS.PROJECTID.eq(projectId))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .fetchOne()
        } else {
            tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.PROJECTID.eq(projectId))
                .and(DAILY_REPORTS.DATE.eq(Dates.parseLocalDate(reportIdOrDate)))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .fetchOne()
        } ?: return null

        val reportId = record.id ?: return null
        return toDto(record, PhotoService.listPhotos(tx, reportId))
    }

    /**
     * Signs and locks a report. A report is signed exactly once: the state is read
     * under a row lock inside the transaction, and the update only matches an unlocked
     * row, so a second signature can neither overwrite the first signer nor the time.
     */
    suspend fun lockReport(user: SessionUser, reportId: UUID) {
        AuditService.auditedWrite(user, "report") { tx ->
            val report = loadForUpdate(tx, reportId)
            val member = ProjectAccess.isMember(tx, user.id, report.projectid!!)

            if (!can(user, Action.ReportSign, Resource(isMember = member))) throw ForbiddenException(Action.ReportSign)
            if (report.lockedat != null) throw ConflictException("Záznam je již podepsán a uzamčen")

            val now = OffsetDateTime.now()
            val signed = tx.update(DAILY_REPORTS)
                .set(DAILY_REPORTS.LOCKEDAT, now)
                .set(DAILY_REPORTS.SIGNEDAT, now)
                .set(DAILY_REPORTS.SIGNEDBYID, user.id)
                .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.LOCKEDAT.isNull))
                .returning()
                .fetchOne() ?: throw ConflictException("Záznam je již podepsán a uzamčen")

            Audited(
                result = Unit,
                action = "report.lock",
                entityId = reportId.toString(),
                before = report.toSnapshot(),
                after = signed.toSnapshot(),
            )
        }
    }

    suspend fun signReport(user: SessionUser, reportId: UUID) = lockReport(user, reportId)

    /**
     * Records that an inspector or investor has taken note of a report. Only a signed
     * (locked) report can be acknowledged, and only once: a later acknowledgement must
     * not replace who acknowledged it and when.
     */
    suspend fun acknowledgeReport(user: SessionUser, reportId: UUID) {
        AuditService.auditedWrite(user, "report") { tx ->
            val report = loadForUpdate(tx, reportId)
            val member = ProjectAccess.isMember(tx, user.id, report.projectid!!)

            if (!can(user, Action.ReportAcknowledge, Resource(isMember = member))) {
                throw ForbiddenException(Action.ReportAcknowledge)
            }
            if (report.lockedat == null) throw ConflictException("Záznam ještě není podepsán")
            if (report.acknowledgedat != null) throw ConflictException("Záznam již byl potvrzen")

            val acknowledged = tx.update(DAILY_REPORTS)
                .set(DAILY_REPORTS.ACKNOWLEDGEDAT, OffsetDateTime.now())
                .set(DAILY_REPORTS.ACKNOWLEDGEDBYID, user.id)
                .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.ACKNOWLEDGEDAT.isNull))
                .returning()
                .fetchOne() ?: throw ConflictException("Záznam již byl potvrzen")

            Audited(
                result = Unit,
                action = "report.acknowledge",
                entityId = reportId.toString(),
                before = report.toSnapshot(),
                after = acknowledged.toSnapshot(),
            )
        }
    }

    private fun loadForUpdate(tx: DSLContext, reportId: UUID): DailyReportsRecord =
        tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .forUpdate()
            .fetchOne() ?: throw NotFoundException("Záznam nenalezen")

    private fun toDto(record: DailyReportsRecord, photos: List<PhotoDto>) = DailyReportDto(
        id = record.id.toString(),
        projectId = record.projectid.toString(),
        date = record.date.toString(),
        weather = null,
        generalNotes = record.othernotes,
        isLocked = record.lockedat != null,
        workDescription = record.workdescription ?: "",
        workersByTrade = record.workersbytrade?.data() ?: "[]",
        isControlDay = record.iscontrolday ?: false,
        constructionObj = record.constructionobj,
        isSigned = record.signedat != null,
        isAcknowledged = record.acknowledgedat != null,
        photos = photos
    )

    private fun DailyReportsRecord.toSnapshot(): JsonElement = Json.encodeToJsonElement(
        ReportSnapshot.serializer(),
        ReportSnapshot(
            id = id.toString(),
            projectId = projectid.toString(),
            date = date.toString(),
            sequenceNumber = get(DAILY_REPORTS.SEQUENCENUMBER)!!,
            authorId = get(DAILY_REPORTS.AUTHORID).toString(),
            workDescription = workdescription ?: "",
            workersByTrade = workersbytrade?.data() ?: "[]",
            isControlDay = iscontrolday ?: false,
            constructionObj = constructionobj,
            signedAt = signedat?.toString(),
            signedById = get(DAILY_REPORTS.SIGNEDBYID)?.toString(),
            lockedAt = lockedat?.toString(),
            acknowledgedAt = acknowledgedat?.toString(),
            acknowledgedById = get(DAILY_REPORTS.ACKNOWLEDGEDBYID)?.toString(),
        )
    )
}
