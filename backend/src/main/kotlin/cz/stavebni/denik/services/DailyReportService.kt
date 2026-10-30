package cz.stavebni.denik.services

import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SignerNotQualifiedException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.Role
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
import org.jooq.impl.DSL
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
    /**
     * The weather as the words people read and the signature covers (`WeatherData.describe()`, "zataženo, 8,5 až 15 °C"), or null
     * when nothing is stated. The entry page shows this text, so what it prints is what the PDF prints and the signature covers.
     */
    val weatherText: String? = null,
    /**
     * The display name of the author of the entry **as the account had it when the entry was made** (stored with the entry and never
     * changed, backlog B9: renaming the user later does not rename the author of an old entry; the PDF prints the same name).
     */
    val authorName: String? = null,
    /** What the vyhláška asks an entry to say besides the day's work (see [EntryDetails]); only the fields that have a text, by key. */
    val details: Map<String, String> = emptyMap(),
    val isLocked: Boolean = false,
    val workDescription: String = "",
    val workersByTrade: String = "[]",
    val isControlDay: Boolean = false,
    val constructionObj: String? = null,
    val isSigned: Boolean = false,
    /** The number of the entry in the diary, given when it is signed (decision D11); null while it is a draft. */
    val sequenceNumber: Int? = null,
    /** Somebody has taken note of the signed entry; who and when is in [acknowledgements]. */
    val isAcknowledged: Boolean = false,
    /** Each party that has taken note of the signed entry (technical supervision, author's supervision, the client, ...), oldest first. */
    val acknowledgements: List<AcknowledgementDto> = emptyList(),
    /** An entry for a day earlier than today and the previous working day (decision D10); it carries the author's reason. */
    val isLateEntry: Boolean = false,
    val lateEntryReason: String? = null,
    /**
     * When the entry was last changed (ISO-8601). A client that edits the entry sends it back as
     * `expectedUpdatedAt`: the save is refused (409) when somebody else changed the entry in between.
     */
    val updatedAt: String? = null,
    /** When the entry was signed (ISO-8601), or null. */
    val signedAt: String? = null,
    /**
     * Who signed, so the page shows it without a click on "Ověřit podpis" (which still verifies). From signature format 3 on it is the
     * name and the ČKAIT number **stored when the entry was signed** ([signerFrozen]); an entry of format 1 or 2 (test data only)
     * has none stored and shows the account as it is now, as the signature check does. Null for a draft.
     */
    val signerName: String? = null,
    val signerCkaitNumber: String? = null,
    /** [signerName] and [signerCkaitNumber] are the stored ones (format 3), not read from the account as it is now. */
    val signerFrozen: Boolean = false,
    /**
     * A signature of format 3 needs both the name and the ČKAIT number of the signer; the database refuses a row that lacks either,
     * and the PDF and the signature check call such a row a failure. True when the entry is signed in format 3 and one of them is
     * missing or blank (only a row changed behind the application's back): the page says the data is incomplete instead of showing
     * half a signer as if it were whole.
     */
    val signerIncomplete: Boolean = false,
    /**
     * Whether the person who asks may change this entry (the same decision as the save: `ReportUpdate` in `Rbac.kt`, a manager of
     * the project any unsigned entry, a worker their own, nobody a signed one, nobody who is no member). False when the caller is
     * not known (an internal read). The page offers the form only when it is true, instead of a form whose save ends in 403.
     */
    val canEdit: Boolean = false,
    /** SHA-256 of the entry's content at signing (see [ReportSignature]); null while unsigned. */
    val signatureHash: String? = null,
    val photos: List<PhotoDto> = emptyList()
)

/** One party's acknowledgement of a signed entry; [name] is the name the person had when they took note (stored with the acknowledgement). */
@Serializable
data class AcknowledgementDto(val userId: String, val name: String, val role: String, val at: String)

/** What the audit log keeps of one acknowledgement: who took note, with the name and the ČKAIT number (if any) stored with it. */
@Serializable
internal data class AcknowledgementSnapshot(
    val id: String,
    val reportId: String,
    val projectId: String,
    val userId: String,
    val userName: String,
    val userCkaitNumber: String? = null,
    val role: String,
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
    val sequenceNumber: Int? = null,
    val authorId: String,
    /** The author's name as it was when the entry was made (stored with the entry). */
    val authorName: String? = null,
    val workDescription: String,
    val workersByTrade: String,
    val isControlDay: Boolean,
    val constructionObj: String?,
    val signedAt: String?,
    val signedById: String?,
    val lockedAt: String?,
    val isLateEntry: Boolean = false,
    val lateEntryReason: String? = null,
    /** The weather as readable text (see [WeatherData.describe]); no decimals in the audit snapshot. */
    val weather: String? = null,
    /** SHA-256 of the content at signing (see [ReportSignature]). */
    val signatureHash: String? = null,
    /** What a signed entry's signature covers (see [ReportSignature.CURRENT_FORMAT]); only for a signed entry. */
    val signatureFormat: Int? = null,
    /** Format 3: the name and the ČKAIT number of the signer as they were when the entry was signed (so the chain holds them too). */
    val signerName: String? = null,
    val signerCkaitNumber: String? = null,
    /** Format 3: the SHA-256 of the identification of the diary stored with the signature (see [PartASnapshot]). */
    val partASha256: String? = null,
    /** The fields of [EntryDetails] that have a text, by key. */
    val details: Map<String, String> = emptyMap(),
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
         * The fields of [EntryDetails] by key. A key that is not mentioned keeps what is stored, an empty text clears the
         * field; an unknown key or a too long text is a 400.
         */
        val details: Map<String, String>? = null,
        /**
         * The client saw no entry for this day when it loaded the form. If one exists by now (somebody else created it), the
         * save is stale: it must not silently replace that entry.
         */
        val expectNew: Boolean = false,
    )

    private enum class WriteMode { CREATE_ONLY, SAVE }

    private const val MAX_NAMES_PER_TRADE = 200
    private const val MAX_NAME_CHARS = 100

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
            EntryDetails.requireNoNul(row.trade, "Název profese")
            require(row.count in 0..100_000) { "Počet pracovníků u profese '${row.trade.trim()}' musí být celé číslo od 0 do 100000" }
            require(row.names.size <= row.count) { "U profese '${row.trade.trim()}' je uvedeno více jmen (${row.names.size}) než pracovníků (${row.count})" }
            require(row.names.size <= MAX_NAMES_PER_TRADE) { "U profese '${row.trade.trim()}' lze uvést nejvýše $MAX_NAMES_PER_TRADE jmen" }
            for (name in row.names) {
                require(name.isNotBlank()) { "Jméno pracovníka u profese '${row.trade.trim()}' nesmí být prázdné" }
                EntryDetails.requireNoNul(name, "Jméno pracovníka")
                // The form and the PDF separate names with a semicolon: a name that holds one would read as two people.
                require(!name.contains(';')) { "Jméno pracovníka nesmí obsahovat středník (odděluje jména)" }
                require(name.trim().length <= MAX_NAME_CHARS) { "Jméno pracovníka může mít nejvýše $MAX_NAME_CHARS znaků" }
            }
        }
        return workersJsonFormat.encodeToString(
            workersSerializer,
            rows.map { row -> row.copy(trade = row.trade.trim(), names = row.names.map { it.trim() }) },
        )
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
        require(text.isNotEmpty()) { "Záznam za $date je pozdní záznam (dnes je $today): uveďte důvod pozdního záznamu" }
        require(text.length <= MAX_LATE_REASON_CHARS) { "Důvod pozdního záznamu může mít nejvýše $MAX_LATE_REASON_CHARS znaků" }
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
        weather: WeatherData? = null,
        details: Map<String, String>? = null,
    ): DailyReportDto = write(
        user, projectId, date, WriteMode.CREATE_ONLY,
        ReportInput(workDescription, workersByTrade, isControlDay, constructionObj, lateEntryReason = lateEntryReason, weather = weather, details = details),
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
        // Only what the request mentions; the keys are checked before anything is locked.
        val detailValues: Map<org.jooq.Field<*>, String?> = input.details?.let { mentioned ->
            EntryDetails.validated(mentioned).mapKeys { it.key.column }
        } ?: emptyMap()

        return AuditService.auditedWrite(user, "report") { tx ->
            if (!tx.fetchExists(PROJECTS, PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))) {
                throw NotFoundException("Projekt nenalezen")
            }
            // Real membership: an app admin who is not a member of the project may read it, not write to it.
            val role = ProjectAccess.roleIn(tx, user.id, projectId)
            assertCan(user, Action.ReportCreate, Resource(role = role))

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
                // The author's name as the account says it now: stored with the entry and never changed (backlog B9).
                val author = AccountIdentity.of(tx, user.id)
                val created = tx.insertInto(DAILY_REPORTS)
                    .set(DAILY_REPORTS.PROJECTID, projectId)
                    .set(DAILY_REPORTS.AUTHORID, user.id)
                    .set(DAILY_REPORTS.AUTHORNAME, author.name)
                    .set(DAILY_REPORTS.DATE, parsedDate)
                    .set(DAILY_REPORTS.WORKERSBYTRADE, workers ?: JSONB.valueOf("[]"))
                    .set(DAILY_REPORTS.WORKDESCRIPTION, input.workDescription ?: "")
                    .set(DAILY_REPORTS.ISCONTROLDAY, input.isControlDay ?: false)
                    .set(DAILY_REPORTS.CONSTRUCTIONOBJ, input.constructionObj)
                    .set(DAILY_REPORTS.ISLATEENTRY, lateReason != null)
                    .set(DAILY_REPORTS.LATEENTRYREASON, lateReason)
                    .set(DAILY_REPORTS.WEATHER, weather?.let { JSONB.valueOf(weatherJson.encodeToString(WeatherData.serializer(), it)) })
                    .set(detailValues)
                    .returning()
                    .fetchOne() ?: throw IllegalStateException("Failed to insert report")

                Audited(
                    result = toDto(created, emptyList(), whoOf(tx, created), canEdit = mayEdit(user, role, created)),
                    action = "report.create",
                    entityId = created.id.toString(),
                    after = created.toSnapshot(),
                )
            } else {
                if (input.expectNew) {
                    throw StaleVersionException("Záznam pro tento den mezitím někdo založil. Načtěte stránku znovu, aby se jeho záznam nepřepsal.")
                }
                if (mode == WriteMode.CREATE_ONLY) {
                    throw ConflictException("Záznam pro tento den již existuje")
                }
                if (existing.lockedat != null) {
                    throw ConflictException("Záznam je podepsán a uzamčen, nelze jej měnit")
                }
                // A site manager of the project may correct any entry; anyone else only their own.
                assertCan(user, Action.ReportUpdate, Resource(role = role, authorId = existing.authorid))
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
                    .set(detailValues)
                    .set(DAILY_REPORTS.UPDATEDAT, OffsetDateTime.now())
                    .where(DAILY_REPORTS.ID.eq(existing.id).and(DAILY_REPORTS.LOCKEDAT.isNull))
                    .returning()
                    .fetchOne() ?: throw ConflictException("Záznam je podepsán a uzamčen, nelze jej měnit")

                Audited(
                    result = toDto(
                        updated, PhotoService.listPhotos(tx, updated.id!!), whoOf(tx, updated),
                        acknowledgementsOf(tx, listOf(updated.id!!))[updated.id!!].orEmpty(), canEdit = mayEdit(user, role, updated),
                    ),
                    action = "report.update",
                    entityId = updated.id.toString(),
                    before = existing.toSnapshot(),
                    after = updated.toSnapshot(),
                )
            }
        }
    }

    /** A page of the project's entries, newest day first, and how many entries the project has. */
    class ReportPage(val reports: List<DailyReportDto>, val total: Int)

    const val DEFAULT_PAGE_SIZE = 400
    const val MAX_PAGE_SIZE = 1000

    /**
     * One page of a project's entries: at most [limit] (1 to [MAX_PAGE_SIZE]) starting at [offset], newest day first.
     * A diary grows by an entry a day for years, so the list must never be "everything", and the photos of the page
     * come in one query, not one per entry.
     */
    suspend fun getReports(projectId: UUID, limit: Int = DEFAULT_PAGE_SIZE, offset: Int = 0, user: SessionUser? = null): ReportPage {
        require(limit in 1..MAX_PAGE_SIZE) { "limit musí být 1 až $MAX_PAGE_SIZE" }
        require(offset >= 0) { "offset nesmí být záporný" }
        val tx = DatabaseFactory.dsl
        val live = DAILY_REPORTS.PROJECTID.eq(projectId).and(DAILY_REPORTS.DELETEDAT.isNull)
        val rows = selectEntries(tx)
            .where(live)
            .orderBy(DAILY_REPORTS.DATE.desc(), DAILY_REPORTS.ID.desc())
            .limit(limit)
            .offset(offset)
            .fetch()
        val total = tx.fetchCount(DAILY_REPORTS, live)

        val ids = rows.mapNotNull { it.get(DAILY_REPORTS.ID) }
        val photos = PhotoService.listPhotosForReports(tx, ids)
        val acknowledgements = acknowledgementsOf(tx, ids)
        val role = user?.let { ProjectAccess.roleIn(tx, it.id, projectId) }
        return ReportPage(
            reports = rows.mapNotNull { row ->
                val record = row.into(DAILY_REPORTS)
                val reportId = record.id ?: return@mapNotNull null
                toDto(record, photos[reportId].orEmpty(), whoOf(row), acknowledgements[reportId].orEmpty(), canEdit = mayEdit(user, role, record))
            },
            total = total,
        )
    }

    /**
     * A report of [projectId], addressed by its id or its day (`YYYY-MM-DD`).
     * A report id that belongs to another project is "not found", not readable
     * through this project.
     */
    suspend fun getReport(projectId: UUID, reportIdOrDate: String, user: SessionUser? = null): DailyReportDto? {
        val tx = DatabaseFactory.dsl
        val uuid = try {
            UUID.fromString(reportIdOrDate)
        } catch (e: IllegalArgumentException) {
            null
        }
        val row = if (uuid != null) {
            selectEntries(tx)
                .where(DAILY_REPORTS.ID.eq(uuid))
                .and(DAILY_REPORTS.PROJECTID.eq(projectId))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .fetchOne()
        } else {
            selectEntries(tx)
                .where(DAILY_REPORTS.PROJECTID.eq(projectId))
                .and(DAILY_REPORTS.DATE.eq(Dates.parseLocalDate(reportIdOrDate)))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .fetchOne()
        } ?: return null

        val record = row.into(DAILY_REPORTS)
        val reportId = record.id ?: return null
        val role = user?.let { ProjectAccess.roleIn(tx, it.id, projectId) }
        return toDto(
            record, PhotoService.listPhotos(tx, reportId), whoOf(row),
            acknowledgementsOf(tx, listOf(reportId))[reportId].orEmpty(), canEdit = mayEdit(user, role, record),
        )
    }

    /**
     * Signs and locks a report. A report is signed exactly once: the state is read
     * under a row lock inside the transaction, and the update only matches an unlocked
     * row, so a second signature can neither overwrite the first signer nor the time.
     *
     * A signature covers what the signer saw: [expectedUpdatedAt] names the version of the entry and [expectedPartASha256] the digest of
     * part A that the sign dialog showed ([signPreview]); when either is not what is stored when the request is handled the answer is
     * `409 STALE_VERSION` and nothing is signed or recorded. The routes require the digest; `null` here means "no check" and is for the
     * callers that sign without a dialog (tests, tools).
     */
    suspend fun lockReport(user: SessionUser, reportId: UUID, expectedUpdatedAt: OffsetDateTime? = null, expectedPartASha256: String? = null) {
        AuditService.auditedWrite(user, "report") { tx ->
            val report = loadForUpdate(tx, reportId)
            val role = ProjectAccess.roleIn(tx, user.id, report.projectid!!)

            if (!can(user, Action.ReportSign, Resource(role = role))) throw ForbiddenException(Action.ReportSign)
            if (report.lockedat != null) throw ConflictException("Záznam je již podepsán a uzamčen")
            // A signature covers a version. A signer who names the version they saw is told when it is not the stored one.
            if (expectedUpdatedAt != null && !report.updatedat!!.isEqual(expectedUpdatedAt)) {
                throw StaleVersionException("Záznam se od načtení změnil. Načtěte jej znovu a zkontrolujte, co podepisujete.")
            }

            // A signer of a diary has a ČKAIT number (decision D2). Checked here, in the transaction, on the stored value, which
            // is also what is stored with the signature (format 3): who signed, as the account says it at this moment.
            val signer = requireQualifiedSigner(tx, user)
            // The identification of the diary as it stands at this moment. Nothing can change it while the audit lock is held:
            // every change of the project, its members, its authorised persons and the users goes through the same lock.
            val partA = PartASnapshot.take(tx, report.projectid!!)
            // The signer signs what they saw (backlog C2b): the digest of part A in the dialog is the digest of the text that is stored
            // below, or nothing is signed. Compared here, in the transaction that stores it, so a change that lands between the dialog
            // and this statement is refused and never frozen under somebody's ČKAIT number without their knowing.
            if (expectedPartASha256 != null && partA.sha256 != expectedPartASha256) throw StaleVersionException(PART_A_CHANGED)

            val before = report.toSnapshot()

            // The number is given now (decision D11): the next one of the project, so the signed entries are numbered one
            // after another without gaps however many drafts came and went. We hold the audit lock, so nobody else is
            // signing; the database checks the number as well (V13). It is part of what the signature covers, so it is set
            // on the entry before the hash is computed.
            val number = (tx.select(DSL.max(DAILY_REPORTS.SEQUENCENUMBER)).from(DAILY_REPORTS)
                .where(DAILY_REPORTS.PROJECTID.eq(report.projectid!!))
                .fetchOne(0, Int::class.javaObjectType) ?: 0) + 1
            report.set(DAILY_REPORTS.SEQUENCENUMBER, number)
            // The signature covers the fields of the current format; the entry says which one it was signed in. The signer and part
            // A are part of that format: they are on the entry before the hash is made and written by the one statement below.
            report.set(DAILY_REPORTS.SIGNATUREFORMAT, ReportSignature.CURRENT_FORMAT.toShort())
            report.set(DAILY_REPORTS.SIGNERNAME, signer.name)
            report.set(DAILY_REPORTS.SIGNERCKAITNUMBER, signer.ckaitNumber)
            report.set(DAILY_REPORTS.PARTASNAPSHOT, partA.text)

            // Milliseconds: what the hash covers is exactly what is stored and read back.
            val now = OffsetDateTime.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS)
            val signatureHash = ReportSignature.hash(tx, report, now, user.id)
            val signed = tx.update(DAILY_REPORTS)
                .set(DAILY_REPORTS.SEQUENCENUMBER, number)
                .set(DAILY_REPORTS.SIGNATUREFORMAT, ReportSignature.CURRENT_FORMAT.toShort())
                .set(DAILY_REPORTS.SIGNERNAME, signer.name)
                .set(DAILY_REPORTS.SIGNERCKAITNUMBER, signer.ckaitNumber)
                .set(DAILY_REPORTS.PARTASNAPSHOT, partA.text)
                .set(DAILY_REPORTS.LOCKEDAT, now)
                .set(DAILY_REPORTS.SIGNEDAT, now)
                .set(DAILY_REPORTS.SIGNEDBYID, user.id)
                .set(DAILY_REPORTS.SIGNATUREHASH, signatureHash)
                .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.LOCKEDAT.isNull))
                .returning()
                .fetchOne() ?: throw ConflictException("Záznam je již podepsán a uzamčen")

            Audited(
                result = Unit,
                action = "report.lock",
                entityId = reportId.toString(),
                before = before,
                after = signed.toSnapshot(),
            )
        }
    }

    suspend fun signReport(user: SessionUser, reportId: UUID, expectedUpdatedAt: OffsetDateTime? = null, expectedPartASha256: String? = null) =
        lockReport(user, reportId, expectedUpdatedAt, expectedPartASha256)

    /**
     * Whether [user] may sign this entry at all (role in its project, not yet signed, qualified), without locking or changing
     * anything. The routes ask this before they ask for the password, so a person who cannot sign is told so instead of
     * being asked to prove who they are.
     */
    fun checkMaySign(user: SessionUser, reportId: UUID): UUID {
        val tx = DatabaseFactory.dsl
        val report = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .fetchOne() ?: throw NotFoundException("Záznam nenalezen")
        val role = ProjectAccess.roleIn(tx, user.id, report.projectid!!)
        if (!can(user, Action.ReportSign, Resource(role = role))) throw ForbiddenException(Action.ReportSign)
        if (report.lockedat != null) throw ConflictException("Záznam je již podepsán a uzamčen")
        requireQualifiedSigner(tx, user)
        return report.projectid!!
    }

    /**
     * What the sign dialog shows before the password (backlog C2b): part A of the diary **as signing would freeze it now** (the same
     * [PartASnapshot.take] the signing transaction uses) and its SHA-256, which the sign request names back (`expectedPartASha256`).
     * Read only, and only for a person who may sign this entry (the checks of [checkMaySign]: a worker is `403`, a signed entry `409`),
     * so a person is told before they type a password what they could not do anyway. The reads share one snapshot of the database, so
     * the digest is that of a state the project really was in; a part A too large to be stored is refused here, as at signing.
     */
    fun signPreview(user: SessionUser, reportId: UUID): SignPreview {
        val projectId = checkMaySign(user, reportId)
        val taken = DatabaseFactory.dsl.transactionResult { cfg ->
            val tx = cfg.dsl()
            tx.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            PartASnapshot.take(tx, projectId)
        }
        return SignPreview(partA = taken.partA, partASha256 = taken.sha256)
    }

    /** What the signer is told when the part A they saw is not the one that would be frozen now. The SPA words its own sentence for the dialog; this is the server's. */
    private const val PART_A_CHANGED =
        "Údaje o stavbě, osoby nebo pověřené osoby se od zobrazení změnily. Zkontrolujte je znovu, než záznam podepíšete."

    /** Who signs, as the account says it: the name and the ČKAIT number that are stored with the signature (format 3). */
    private class Signer(val name: String, val ckaitNumber: String)

    private fun requireQualifiedSigner(tx: DSLContext, user: SessionUser): Signer {
        val account = tx.select(USERS.DISPLAYNAME, USERS.CKAITNUMBER).from(USERS).where(USERS.ID.eq(user.id)).fetchOne()
        val ckait = account?.get(USERS.CKAITNUMBER)?.trim()
        if (ckait.isNullOrEmpty()) {
            throw SignerNotQualifiedException("K podpisu záznamu je nutné číslo ČKAIT. Požádejte administrátora, aby je doplnil u vašeho účtu.")
        }
        // A name is required of every account, so this is a safety net: a signature that names nobody is no signature.
        val name = account.get(USERS.DISPLAYNAME)?.trim()
        if (name.isNullOrEmpty()) throw ConflictException("Váš účet nemá vyplněné jméno. Požádejte administrátora, aby je doplnil, a podepište znovu.")
        return Signer(name, ckait)
    }

    /**
     * Records that an inspector or investor has taken note of a signed report. **Every** such member does so on their own
     * behalf and **once**: the technical supervision, the author's supervision and the client are each on record, and a
     * second acknowledgement by the same person is refused instead of replacing the first.
     */
    suspend fun acknowledgeReport(user: SessionUser, reportId: UUID) {
        AuditService.auditedWrite(user, "report") { tx ->
            val report = loadForUpdate(tx, reportId)
            val role = ProjectAccess.roleIn(tx, user.id, report.projectid!!)

            if (!can(user, Action.ReportAcknowledge, Resource(role = role))) {
                throw ForbiddenException(Action.ReportAcknowledge)
            }
            if (report.lockedat == null) throw ConflictException("Záznam ještě není podepsán")
            if (tx.fetchExists(REPORT_ACKNOWLEDGEMENTS, REPORT_ACKNOWLEDGEMENTS.REPORTID.eq(reportId).and(REPORT_ACKNOWLEDGEMENTS.USERID.eq(user.id)))) {
                throw ConflictException("Se záznamem jste se již seznámil(a)")
            }

            // Who takes note, as the account says it now: stored with the acknowledgement, which is never changed.
            val person = AccountIdentity.of(tx, user.id)
            val inserted = tx.insertInto(REPORT_ACKNOWLEDGEMENTS)
                .set(REPORT_ACKNOWLEDGEMENTS.REPORTID, reportId)
                .set(REPORT_ACKNOWLEDGEMENTS.USERID, user.id)
                .set(REPORT_ACKNOWLEDGEMENTS.USERNAME, person.name)
                .set(REPORT_ACKNOWLEDGEMENTS.USERCKAITNUMBER, person.ckaitNumber)
                .set(REPORT_ACKNOWLEDGEMENTS.ROLE, cz.stavebni.denik.jooq.enums.Role.valueOf(role!!.name))
                .returning()
                .fetchOne() ?: throw IllegalStateException("Potvrzení se nepodařilo uložit")

            Audited(
                result = Unit,
                action = "report.acknowledge",
                entityId = reportId.toString(),
                after = Json.encodeToJsonElement(
                    AcknowledgementSnapshot.serializer(),
                    AcknowledgementSnapshot(
                        inserted.get(REPORT_ACKNOWLEDGEMENTS.ID).toString(), reportId.toString(), report.projectid.toString(), user.id.toString(),
                        person.name, person.ckaitNumber, role.name,
                    ),
                ),
            )
        }
    }

    /** The acknowledgements of many entries in one query, keyed by entry, oldest first. */
    private fun acknowledgementsOf(tx: DSLContext, reportIds: Collection<UUID>): Map<UUID, List<AcknowledgementDto>> {
        if (reportIds.isEmpty()) return emptyMap()
        return tx.select(REPORT_ACKNOWLEDGEMENTS.REPORTID, REPORT_ACKNOWLEDGEMENTS.USERID, REPORT_ACKNOWLEDGEMENTS.USERNAME, REPORT_ACKNOWLEDGEMENTS.ROLE, REPORT_ACKNOWLEDGEMENTS.CREATEDAT)
            .from(REPORT_ACKNOWLEDGEMENTS)
            .where(REPORT_ACKNOWLEDGEMENTS.REPORTID.`in`(reportIds))
            .orderBy(REPORT_ACKNOWLEDGEMENTS.CREATEDAT.asc(), REPORT_ACKNOWLEDGEMENTS.ID.asc())
            .fetch()
            .groupBy({ it.get(REPORT_ACKNOWLEDGEMENTS.REPORTID)!! }) {
                AcknowledgementDto(
                    userId = it.get(REPORT_ACKNOWLEDGEMENTS.USERID).toString(),
                    name = it.get(REPORT_ACKNOWLEDGEMENTS.USERNAME) ?: "",
                    role = it.get(REPORT_ACKNOWLEDGEMENTS.ROLE)!!.name,
                    at = it.get(REPORT_ACKNOWLEDGEMENTS.CREATEDAT).toString(),
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
    private fun weatherOf(record: DailyReportsRecord): WeatherData? = WeatherData.fromStored(record.weather?.data())

    /**
     * The account of whoever signed an entry, for the entries that kept no copy of the signer (format 1 and 2, test data only). The
     * author of an entry is not read from the account: its name is stored with the entry (backlog B9).
     */
    private class Who(val signerAccountName: String?, val signerAccountCkait: String?)

    private val SIGNER = USERS.`as`("signer")

    /** The entries (all their columns), each with the account that signed it, in the same statement. */
    private fun selectEntries(tx: DSLContext) =
        tx.select(DAILY_REPORTS.asterisk(), SIGNER.DISPLAYNAME, SIGNER.CKAITNUMBER)
            .from(DAILY_REPORTS)
            .leftJoin(SIGNER).on(SIGNER.ID.eq(DAILY_REPORTS.SIGNEDBYID))

    private fun whoOf(row: org.jooq.Record) = Who(row.get(SIGNER.DISPLAYNAME), row.get(SIGNER.CKAITNUMBER))

    /** The account of the signer for an entry the transaction has just written. */
    private fun whoOf(tx: DSLContext, record: DailyReportsRecord): Who =
        selectEntries(tx).where(DAILY_REPORTS.ID.eq(record.id)).fetchOne()?.let { whoOf(it) } ?: Who(null, null)

    /**
     * Whether [user], who holds [role] in the project, may change the entry [record]: **the decision the save makes** (`ReportUpdate`
     * in Rbac.kt: a manager any unsigned entry, a worker their own, nobody a signed one or one of a project they are no member of),
     * so the page offers the form exactly when the save would be accepted. False when the caller is not known.
     */
    private fun mayEdit(user: SessionUser?, role: Role?, record: DailyReportsRecord): Boolean =
        user != null && record.lockedat == null && can(user, Action.ReportUpdate, Resource(role = role, authorId = record.authorid))

    private fun toDto(
        record: DailyReportsRecord,
        photos: List<PhotoDto>,
        who: Who,
        acknowledgements: List<AcknowledgementDto> = emptyList(),
        canEdit: Boolean = false,
    ): DailyReportDto {
        val signed = record.signedat != null
        // From signature format 3 the signer is what was stored when the entry was signed. Before, no copy was kept and the account
        // is read as it is now, which is also what the signature check says of such an entry.
        val frozen = (record.get(DAILY_REPORTS.SIGNATUREFORMAT)?.toInt() ?: 1) >= 3
        val weather = weatherOf(record)
        return DailyReportDto(
            id = record.id.toString(),
            projectId = record.projectid.toString(),
            date = record.date.toString(),
            weather = weather,
            weatherText = weather?.describe()?.takeIf { it.isNotEmpty() },
            authorName = record.get(DAILY_REPORTS.AUTHORNAME),
            details = EntryDetails.filledOf(record),
            isLocked = record.lockedat != null,
            sequenceNumber = record.get(DAILY_REPORTS.SEQUENCENUMBER),
            workDescription = record.workdescription ?: "",
            workersByTrade = record.workersbytrade?.data() ?: "[]",
            isControlDay = record.iscontrolday ?: false,
            constructionObj = record.constructionobj,
            isSigned = signed,
            isAcknowledged = acknowledgements.isNotEmpty(),
            acknowledgements = acknowledgements,
            isLateEntry = record.islateentry ?: false,
            lateEntryReason = record.lateentryreason,
            updatedAt = record.updatedat?.toString(),
            signedAt = record.signedat?.toString(),
            signerName = if (!signed) null else if (frozen) record.get(DAILY_REPORTS.SIGNERNAME) else who.signerAccountName,
            signerCkaitNumber = if (!signed) null else if (frozen) record.get(DAILY_REPORTS.SIGNERCKAITNUMBER) else who.signerAccountCkait,
            signerFrozen = signed && frozen,
            // Format 3 needs both; the database refuses a row without one, so this is a row that was changed behind the application.
            signerIncomplete = signed && frozen && (record.get(DAILY_REPORTS.SIGNERNAME).isNullOrBlank() || record.get(DAILY_REPORTS.SIGNERCKAITNUMBER).isNullOrBlank()),
            canEdit = canEdit,
            signatureHash = record.get(DAILY_REPORTS.SIGNATUREHASH),
            photos = photos,
        )
    }

    private fun DailyReportsRecord.toSnapshot(): JsonElement = Json.encodeToJsonElement(
        ReportSnapshot.serializer(),
        ReportSnapshot(
            id = id.toString(),
            projectId = projectid.toString(),
            date = date.toString(),
            sequenceNumber = get(DAILY_REPORTS.SEQUENCENUMBER),
            authorId = get(DAILY_REPORTS.AUTHORID).toString(),
            authorName = get(DAILY_REPORTS.AUTHORNAME),
            workDescription = workdescription ?: "",
            workersByTrade = workersbytrade?.data() ?: "[]",
            isControlDay = iscontrolday ?: false,
            constructionObj = constructionobj,
            signedAt = signedat?.toString(),
            signedById = get(DAILY_REPORTS.SIGNEDBYID)?.toString(),
            lockedAt = lockedat?.toString(),
            isLateEntry = islateentry ?: false,
            lateEntryReason = lateentryreason,
            details = EntryDetails.filledOf(this),
            weather = weatherOf(this)?.describe(),
            signatureHash = get(DAILY_REPORTS.SIGNATUREHASH),
            signatureFormat = if (lockedat != null) get(DAILY_REPORTS.SIGNATUREFORMAT)?.toInt() else null,
            signerName = get(DAILY_REPORTS.SIGNERNAME),
            signerCkaitNumber = get(DAILY_REPORTS.SIGNERCKAITNUMBER),
            partASha256 = get(DAILY_REPORTS.PARTASNAPSHOT)?.let { PartASnapshot.sha256(it) },
        )
    )
}
