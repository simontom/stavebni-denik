package cz.stavebni.denik.services

import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.StaleVersionException
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
import java.time.Clock
import java.time.LocalDate
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
    /** An entry for a day earlier than today and the previous working day (decision D10); it carries the author's reason. */
    val isLateEntry: Boolean = false,
    val lateEntryReason: String? = null,
    /**
     * When the entry was last changed (ISO-8601). A client that edits the entry sends it back as
     * `expectedUpdatedAt`: the save is refused (409) when somebody else changed the entry in between.
     */
    val updatedAt: String? = null,
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
    val isLateEntry: Boolean = false,
    val lateEntryReason: String? = null,
    /** The weather as readable text (see [WeatherData.describe]); no decimals in the audit snapshot. */
    val weather: String? = null,
)

object DailyReportService {

    /** What a save request mentions. A value that is `null` was not mentioned and leaves what is stored unchanged. */
    class ReportInput(
        val workDescription: String? = null,
        val workersByTrade: String? = null,
        val isControlDay: Boolean? = null,
        val constructionObj: String? = null,
        /** The `updatedAt` of the entry as the client last saw it; when given, the save only goes through if it still matches. */
        val expectedUpdatedAt: OffsetDateTime? = null,
        /** Why an entry for an earlier day is only written now; required for such an entry, ignored for an on-time one. */
        val lateEntryReason: String? = null,
        /** The weather as entered; null = not mentioned (keeps what is stored), an empty value clears it. */
        val weather: WeatherData? = null,
        /**
         * The client saw no entry for this day when it loaded the form. If one exists by now (somebody else created it), the
         * save is stale: it must not silently replace that entry.
         */
        val expectNew: Boolean = false,
    )

    private enum class WriteMode { CREATE_ONLY, SAVE }

    private val workersSerializer = kotlinx.serialization.builtins.ListSerializer(cz.stavebni.denik.domain.WorkerEntry.serializer())
    private val workersJsonFormat = Json { ignoreUnknownKeys = false }

    /**
     * The workers list as stored: a list of {trade, count} with a named trade and a whole, non-negative head count. Nothing is
     * invented (no default count) and nothing is silently dropped: anything else is a 400.
     */
    private fun validatedWorkers(raw: String): String {
        val rows = try {
            workersJsonFormat.decodeFromString(workersSerializer, raw.ifBlank { "[]" })
        } catch (e: kotlinx.serialization.SerializationException) {
            throw IllegalArgumentException("Seznam pracovníků není platný: každá položka má profesi a celý počet pracovníků")
        }
        require(rows.size <= 50) { "Seznam pracovníků může mít nejvýše 50 profesí" }
        for (row in rows) {
            require(row.trade.isNotBlank()) { "Každá profese v seznamu pracovníků musí mít název" }
            require(row.count in 0..100_000) { "Počet pracovníků u profese '${row.trade.trim()}' musí být celé číslo od 0 do 100000" }
        }
        return workersJsonFormat.encodeToString(workersSerializer, rows.map { it.copy(trade = it.trade.trim()) })
    }

    /** The clock behind "today" (Prague time); tests replace it. */
    @Volatile
    var clock: Clock = Clock.system(Dates.PRAGUE)

    /** Longest accepted reason for a late entry. */
    const val MAX_LATE_REASON_CHARS = 1_000

    /**
     * Decision D10: a new entry is for today or for a day since the previous working day. An earlier day is a late
     * entry and needs a reason (returned, to be stored with the flag); a day in the future is refused.
     * Returns null for an entry that is on time. Only a *new* entry is checked: correcting an existing one is not a new entry.
     */
    private fun lateReasonFor(date: LocalDate, reason: String?): String? {
        if (!AppConfig.entryDateWindowEnforced) return null
        val today = Dates.today(clock)
        require(!date.isAfter(today)) { "Záznam nelze založit pro budoucí datum ($date)" }
        if (!date.isBefore(Dates.previousWorkingDay(today))) return null
        val text = reason?.trim().orEmpty()
        require(text.isNotEmpty()) { "Záznam za $date je pozdní zápis (dnes je $today): uveďte důvod pozdního zápisu" }
        require(text.length <= MAX_LATE_REASON_CHARS) { "Důvod pozdního zápisu může mít nejvýše $MAX_LATE_REASON_CHARS znaků" }
        return text
    }

    /**
     * Creates the report of a day. A day that already has a report is a conflict (409), never an overwrite.
     */
    suspend fun createReport(
        user: SessionUser,
        projectId: UUID,
        date: String,
        workDescription: String = "",
        workersByTrade: String = "[]",
        isControlDay: Boolean = false,
        constructionObj: String? = null,
        lateEntryReason: String? = null,
        weather: WeatherData? = null
    ): DailyReportDto = write(
        user, projectId, date, WriteMode.CREATE_ONLY,
        ReportInput(workDescription, workersByTrade, isControlDay, constructionObj, lateEntryReason = lateEntryReason, weather = weather),
    )

    /**
     * Saves the report of a day: creates it when there is none, otherwise changes the fields that [input]
     * mentions while the report is still unsigned. What the request leaves out is kept, so an incomplete
     * request can never blank an entry.
     */
    suspend fun saveReport(user: SessionUser, projectId: UUID, date: String, input: ReportInput): DailyReportDto =
        write(user, projectId, date, WriteMode.SAVE, input)

    /**
     * Everything that depends on the current state (does the report exist, is it signed, is the caller
     * really a member of the project, did the caller write it) is decided inside the audited transaction,
     * on a row locked `FOR UPDATE`.
     */
    private suspend fun write(user: SessionUser, projectId: UUID, date: String, mode: WriteMode, input: ReportInput): DailyReportDto {
        val parsedDate = Dates.parseLocalDate(date)
        val workers = input.workersByTrade?.let { JSONB.valueOf(validatedWorkers(it)) }
        // null = not mentioned; a mentioned but empty weather becomes "no weather".
        val weatherMentioned = input.weather != null
        val weather: WeatherData? = input.weather?.validated()

        return AuditService.auditedWrite(user, "report") { tx ->
            if (!tx.fetchExists(PROJECTS, PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))) {
                throw NotFoundException("Projekt nenalezen")
            }
            // Real membership: an app admin who is not a member of the project may read it, not write to it.
            val isMember = ProjectAccess.isMember(tx, user.id, projectId)
            assertCan(user, Action.ReportCreate, Resource(isMember = isMember))

            val existing = tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.PROJECTID.eq(projectId))
                .and(DAILY_REPORTS.DATE.eq(parsedDate))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .forUpdate()
                .fetchOne()

            if (existing == null) {
                if (input.expectedUpdatedAt != null) {
                    throw StaleVersionException("Záznam, který upravujete, už neexistuje. Načtěte stránku znovu.")
                }
                val lateReason = lateReasonFor(parsedDate, input.lateEntryReason)
                val nextSeq = tx.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)) + 1
                val created = tx.insertInto(DAILY_REPORTS)
                    .set(DAILY_REPORTS.PROJECTID, projectId)
                    .set(DAILY_REPORTS.AUTHORID, user.id)
                    .set(DAILY_REPORTS.DATE, parsedDate)
                    .set(DAILY_REPORTS.SEQUENCENUMBER, nextSeq)
                    .set(DAILY_REPORTS.WORKERSBYTRADE, workers ?: JSONB.valueOf("[]"))
                    .set(DAILY_REPORTS.WORKDESCRIPTION, input.workDescription ?: "")
                    .set(DAILY_REPORTS.ISCONTROLDAY, input.isControlDay ?: false)
                    .set(DAILY_REPORTS.CONSTRUCTIONOBJ, input.constructionObj)
                    .set(DAILY_REPORTS.ISLATEENTRY, lateReason != null)
                    .set(DAILY_REPORTS.LATEENTRYREASON, lateReason)
                    .set(DAILY_REPORTS.WEATHER, weather?.let { JSONB.valueOf(weatherJson.encodeToString(WeatherData.serializer(), it)) })
                    .returning()
                    .fetchOne() ?: throw IllegalStateException("Failed to insert report")

                Audited(
                    result = toDto(created, emptyList()),
                    action = "report.create",
                    entityId = created.id.toString(),
                    after = created.toSnapshot(),
                )
            } else {
                if (input.expectNew) {
                    throw StaleVersionException("Záznam pro tento den mezitím někdo založil. Načtěte stránku znovu, aby se jeho zápis nepřepsal.")
                }
                if (mode == WriteMode.CREATE_ONLY) {
                    throw ConflictException("Záznam pro tento den již existuje")
                }
                if (existing.lockedat != null) {
                    throw ConflictException("Záznam je podepsán a uzamčen, nelze jej měnit")
                }
                // A site manager of the project may correct any entry; anyone else only their own.
                assertCan(user, Action.ReportUpdate, Resource(isMember = isMember, authorId = existing.authorid))
                // The row is locked, so this is an atomic compare-and-set: whoever saved first wins, the other is told.
                if (input.expectedUpdatedAt != null && !existing.updatedat!!.isEqual(input.expectedUpdatedAt)) {
                    throw StaleVersionException("Záznam mezitím změnil někdo jiný. Načtěte jej znovu, aby se jeho změny neztratily.")
                }

                val updated = tx.update(DAILY_REPORTS)
                    .set(DAILY_REPORTS.WORKDESCRIPTION, input.workDescription ?: existing.workdescription)
                    .set(DAILY_REPORTS.WORKERSBYTRADE, workers ?: existing.workersbytrade)
                    .set(DAILY_REPORTS.ISCONTROLDAY, input.isControlDay ?: existing.iscontrolday)
                    .set(DAILY_REPORTS.CONSTRUCTIONOBJ, input.constructionObj ?: existing.constructionobj)
                    .set(
                        DAILY_REPORTS.WEATHER,
                        if (weatherMentioned) weather?.let { JSONB.valueOf(weatherJson.encodeToString(WeatherData.serializer(), it)) } else existing.weather
                    )
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
    suspend fun lockReport(user: SessionUser, reportId: UUID, expectedUpdatedAt: OffsetDateTime? = null) {
        AuditService.auditedWrite(user, "report") { tx ->
            val report = loadForUpdate(tx, reportId)
            val member = ProjectAccess.isMember(tx, user.id, report.projectid!!)

            if (!can(user, Action.ReportSign, Resource(isMember = member))) throw ForbiddenException(Action.ReportSign)
            if (report.lockedat != null) throw ConflictException("Záznam je již podepsán a uzamčen")
            // A signature covers a version. A signer who names the version they saw is told when it is not the stored one.
            if (expectedUpdatedAt != null && !report.updatedat!!.isEqual(expectedUpdatedAt)) {
                throw StaleVersionException("Záznam se od načtení změnil. Načtěte jej znovu a zkontrolujte, co podepisujete.")
            }

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

    suspend fun signReport(user: SessionUser, reportId: UUID, expectedUpdatedAt: OffsetDateTime? = null) =
        lockReport(user, reportId, expectedUpdatedAt)

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

    private val weatherJson = Json { ignoreUnknownKeys = true }

    /** The weather stored on the row; the legacy placeholder `{}` and unreadable values count as "not stated". */
    private fun weatherOf(record: DailyReportsRecord): WeatherData? =
        record.weather?.data()?.let { raw ->
            runCatching { weatherJson.decodeFromString(WeatherData.serializer(), raw) }.getOrNull()
        }?.takeUnless { it.isEmpty() }

    private fun toDto(record: DailyReportsRecord, photos: List<PhotoDto>) = DailyReportDto(
        id = record.id.toString(),
        projectId = record.projectid.toString(),
        date = record.date.toString(),
        weather = weatherOf(record),
        generalNotes = record.othernotes,
        isLocked = record.lockedat != null,
        workDescription = record.workdescription ?: "",
        workersByTrade = record.workersbytrade?.data() ?: "[]",
        isControlDay = record.iscontrolday ?: false,
        constructionObj = record.constructionobj,
        isSigned = record.signedat != null,
        isAcknowledged = record.acknowledgedat != null,
        isLateEntry = record.islateentry ?: false,
        lateEntryReason = record.lateentryreason,
        updatedAt = record.updatedat?.toString(),
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
            isLateEntry = islateentry ?: false,
            lateEntryReason = lateentryreason,
            weather = weatherOf(this)?.describe(),
        )
    )
}
