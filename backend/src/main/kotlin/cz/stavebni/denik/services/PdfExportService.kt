package cz.stavebni.denik.services

import cz.stavebni.denik.domain.AppJson
import cz.stavebni.denik.domain.HandoverSide
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.domain.WorkerEntry
import cz.stavebni.denik.jooq.tables.records.SiteHandoverSignaturesRecord
import cz.stavebni.denik.jooq.tables.records.DailyReportsRecord
import cz.stavebni.denik.jooq.tables.references.*
import cz.stavebni.denik.util.CzechFormat
import cz.stavebni.denik.util.Dates
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.slf4j.LoggerFactory
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Duration
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Compiles the typst project in [workDir] (main.typ + data.json) into [pdfFile]. */
fun interface TypstCompiler {
    fun compile(workDir: File, typstFile: File, pdfFile: File)
}

/** typst ran but did not produce a PDF (error, timeout, garbage). Details are for the server log only. */
class PdfExportException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/** typst cannot be started at all (for example it is not installed). */
class PdfUnavailableException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/** Both render slots stayed taken for the whole waiting time: the caller is told to come back, not kept waiting. */
class PdfBusyException : RuntimeException("PDF export is busy")

class PdfDocument(val fileName: String, val bytes: ByteArray)

/**
 * Runs the `typst` command line tool.
 *
 * - The output goes to a file, never into a pipe nobody reads (a full pipe would block typst forever).
 * - A run that exceeds [timeout] is killed.
 * - The child process only gets PATH (and SystemRoot on Windows) from the environment.
 */
class ProcessTypstCompiler(
    private val command: (workDir: File, typstFile: File, pdfFile: File) -> List<String> = { dir, typ, pdf ->
        listOf(
            "typst", "compile",
            "--root", dir.absolutePath,    // typst cannot read anything outside this directory
            "--ignore-system-fonts",       // the fonts built into typst cover Czech; output does not depend on the host
            typ.absolutePath, pdf.absolutePath,
        )
    },
    private val timeout: Duration = Duration.ofSeconds(20),
) : TypstCompiler {

    override fun compile(workDir: File, typstFile: File, pdfFile: File) {
        val log = File(workDir, "typst.log")
        val builder = ProcessBuilder(command(workDir, typstFile, pdfFile))
            .directory(workDir)
            .redirectErrorStream(true)
            .redirectOutput(log)
        builder.environment().keys.retainAll { it.uppercase() in setOf("PATH", "SYSTEMROOT") }

        val process = try {
            builder.start()
        } catch (e: IOException) {
            throw PdfUnavailableException("typst could not be started", e)
        }

        if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
            process.destroyForcibly()
            process.waitFor(5, TimeUnit.SECONDS)
            throw PdfExportException("typst did not finish within ${timeout.seconds} s and was killed")
        }
        val exit = process.exitValue()
        if (exit != 0) {
            throw PdfExportException("typst failed (exit code $exit): ${log.readText().take(500)}")
        }
    }
}

object PdfExportService {
    private val log = LoggerFactory.getLogger(PdfExportService::class.java)

    /**
     * The labels of the rows of part A that příloha 12 A a) and c) words in a certain way: the number of the permit ("číslo jednací"),
     * and the business name, the seat (or the name and the address) and the IČO of the builder, the contractor, the designer and the
     * subcontractors. The screen says the same (`LABELS` in frontend/src/lib/projectFields.ts; `partALabels.test.ts` fails when the two
     * drift apart), and so does `report.typ` for the subcontractors. Only labels: the keys of the fields are never touched, because
     * they are part of what a signature covers.
     */
    object PartALabels {
        const val BUILDER = "Stavebník (název a sídlo, IČO)"
        const val CONTRACTOR = "Zhotovitel (název a sídlo, IČO)"
        const val DESIGNER = "Projektant (název a sídlo, IČO)"
        const val SUBCONTRACTORS = "Poddodavatelé (název, sídlo, IČO)"
        const val PERMIT = "Číslo jednací povolení"
    }

    @Volatile
    var compiler: TypstCompiler = ProcessTypstCompiler()

    /** At most two PDFs are rendered at the same time; the others wait. */
    private val slots = Semaphore(2)

    /**
     * How long a request waits for a free slot before it is refused with [PdfBusyException] (503). A render takes up to
     * 20 s, so an unbounded queue would hold request threads and browsers for minutes while everyone retries.
     */
    @Volatile
    var queueWait: Duration = Duration.ofSeconds(10)

    /** The fixed template. It contains no user text (see the comment in the file). */
    internal val template: String by lazy {
        PdfExportService::class.java.getResourceAsStream("/pdf/report.typ")!!
            .use { it.readBytes().toString(StandardCharsets.UTF_8) }
    }

    private val json = AppJson.api

    suspend fun generateReportPdf(tx: DSLContext, reportId: UUID): PdfDocument {
        val data = loadData(tx, reportId)
        // The flag is set inside the timed block and read outside it: a timeout that fires just after the permit was
        // granted must not lose track of the permit.
        var acquired = false
        withTimeoutOrNull(queueWait.toMillis()) {
            slots.acquire()
            acquired = true
        }
        if (!acquired) throw PdfBusyException()
        try {
            return withContext(Dispatchers.IO) { render(data, reportId) }
        } finally {
            slots.release()
        }
    }

    // ---- the sections of the document, one function each -----------------------------------------------------------

    /**
     * A person as the document names them: the name, and with [withCkait] their ČKAIT number as it stands now. A text longer than
     * its limit is cut with an ellipsis: the signature block may not be split between pages, so it must have a known height
     * (`displayName` and `ckaitNumber` are bounded only by the size of a request; the signature check shows the full values).
     */
    private fun personOf(tx: DSLContext, id: UUID?, withCkait: Boolean = false, nameLimit: Int = Int.MAX_VALUE, ckaitLimit: Int = Int.MAX_VALUE): String {
        if (id == null) return ""
        val user = tx.select(USERS.DISPLAYNAME, USERS.CKAITNUMBER).from(USERS).where(USERS.ID.eq(id)).fetchOne() ?: return ""
        val name = user.get(USERS.DISPLAYNAME)?.trim().orEmpty().ifEmpty { null }?.let { shortened(it, nameLimit) }
        val ckait = if (withCkait) user.get(USERS.CKAITNUMBER)?.trim().orEmpty().ifEmpty { null }?.let { "ČKAIT ${shortened(it, ckaitLimit)}" } else null
        return listOfNotNull(name, ckait).joinToString(", ")
    }

    /** [text] cut to [limit] characters (code points, so no character is split) with an ellipsis; shorter text is returned as it is. */
    internal fun shortened(text: String, limit: Int): String =
        if (text.codePointCount(0, text.length) <= limit) text else text.substring(0, text.offsetByCodePoints(0, limit)).trimEnd() + "…"

    /** The longest name and ČKAIT number of the signer that the signature block prints. */
    private const val SIGNER_NAME_LIMIT = 120
    private const val SIGNER_CKAIT_LIMIT = 40

    /**
     * The longest name and ČKAIT number printed next to a record that is made later (an addendum, an entry of another party, an
     * acknowledgement): the limits the application puts on an account (200 and 50 characters), so that nothing that was accepted is cut.
     */
    private const val IDENTITY_NAME_LIMIT = 200
    private const val IDENTITY_CKAIT_LIMIT = 50

    /**
     * A person as the document names them next to a record: the name, and `ČKAIT <number>` when the account had a number at the moment
     * the record was made (both as the record stored them; an inspector or an investor often has no number, and nothing is printed then).
     */
    internal fun identityLine(name: String?, ckaitNumber: String?, nameLimit: Int = IDENTITY_NAME_LIMIT, ckaitLimit: Int = IDENTITY_CKAIT_LIMIT): String {
        val shownName = name?.trim().orEmpty().ifEmpty { null }?.let { shortened(it, nameLimit) }
        val shownNumber = ckaitNumber?.trim().orEmpty().ifEmpty { null }?.let { "ČKAIT ${shortened(it, ckaitLimit)}" }
        return listOfNotNull(shownName, shownNumber).joinToString(", ")
    }

    /** A calendar day of part A (`YYYY-MM-DD`: the date of a permit or a contract) in Czech form. */
    private fun partADay(value: String?): String? = value?.let { runCatching { CzechFormat.date(LocalDate.parse(it)) }.getOrDefault(it) }

    /**
     * Part A: the identification of the diary as labelled rows; a row without a value is left out. A number and its date share a
     * row. [partA] is the snapshot stored with the signature (format 3) or part A as it stands now: the rows are the same.
     */
    private fun projectInfoOf(partA: PartA): List<LabeledPdf> {
        val identification = partA.identification
        fun text(key: String) = identification[key]?.trim().orEmpty()
        // A number and its date share a row: "SZ/1 ze dne 15. 3. 2026"; the number alone; and a date whose number is missing says so, so the
        // row under "Číslo jednací povolení" never reads as a bare "ze dne 5. 1. 2026". Neither: no row.
        fun numbered(number: String, date: String): String {
            val day = partADay(date.ifEmpty { null })?.let { "ze dne $it" }
            return when {
                number.isNotEmpty() -> listOfNotNull(number, day).joinToString(" ")
                day != null -> "neuvedeno, $day"
                else -> ""
            }
        }
        fun person(name: String, ckait: String?): String = listOfNotNull(name.ifEmpty { null }, ckait?.let { "ČKAIT $it" }).joinToString(", ")
        // The author's supervision (příloha 12 A e)): who it is, and the number of their authorisation.
        val supervision = listOfNotNull(text("authorSupervisionName").ifEmpty { null }, text("authorSupervisionAuthorization").ifEmpty { null }?.let { "autorizace $it" }).joinToString(", ")
        return listOf(
            "Katastrální území" to text("cadastralArea"),
            "Parcelní čísla" to text("parcelNumbers"),
            PartALabels.BUILDER to text("builder"),
            PartALabels.CONTRACTOR to text("contractor"),
            "Stavbyvedoucí" to person(partA.siteManager.name, partA.siteManager.ckaitNumber),
            PartALabels.DESIGNER to text("designerName"),
            "Autorský dozor" to supervision,
            PartALabels.PERMIT to numbered(text("permitNumber"), text("permitDate")),
            "Technický dozor stavebníka" to text("tdsName"),
            "Koordinátor BOZP" to text("bozpName"),
            "Smlouva" to numbered(text("contractNumber"), text("contractDate")),
            "Projektová dokumentace" to numbered(text("designDocVersion"), text("designDocDate")),
        ).filter { it.second.isNotEmpty() }.map { LabeledPdf(it.first, it.second) }
    }

    /** The persons of part A with the given role (BOSS: who ensures the technical management, INSPECTOR: the supervision), as the table prints them. */
    private fun personsOf(partA: PartA, role: String): List<PartAPersonPdf> =
        partA.members.filter { it.role == role }.map { PartAPersonPdf(it.name, it.ckaitNumber.orEmpty(), it.scope.orEmpty(), it.userId == partA.siteManager.userId) }

    private fun authorizedPersonsOf(partA: PartA): List<AuthorizedPersonPdf> =
        partA.authorizedPersons.map { AuthorizedPersonPdf(it.name, it.company.orEmpty(), it.authorization.orEmpty()) }

    /**
     * The identification is read from the project NOW: a signed entry does not carry a copy of it and the signature does not
     * cover it, so the PDF says so, and says when the project was changed after the entry was signed. Days are Prague days
     * (decision D10): after 22:00 or 23:00 UTC it is already tomorrow in Prague.
     */
    internal fun projectInfoNote(today: LocalDate, lockedAt: OffsetDateTime?, projectChangedAt: OffsetDateTime?): String = buildString {
        append("Údaje o stavbě platné ke dni ${CzechFormat.date(today)}")
        if (lockedAt != null) append(" (nejsou součástí podpisu záznamu)")
        append(".")
        if (lockedAt != null && projectChangedAt != null && projectChangedAt.isAfter(lockedAt)) {
            append(" Po podpisu tohoto záznamu byly změněny dne ${CzechFormat.date(CzechFormat.pragueDate(projectChangedAt))}.")
        }
    }

    /**
     * Signed in format 3 the identification is the one that was stored with the signature, which is part of what is signed: it is
     * the day of signing (Prague day, decision D10), and nothing later changes it, so there is nothing to say about later changes.
     */
    internal fun projectInfoNoteFrozen(signedAt: OffsetDateTime): String =
        "Údaje o stavbě platné ke dni podpisu ${CzechFormat.date(CzechFormat.pragueDate(signedAt))} (stav v okamžiku podpisu záznamu); jsou součástí podpisu záznamu."

    /** A signature of format 3 whose stored part A is missing or unreadable cannot be verified, and the document says so instead of printing today's data in its place. */
    internal const val PART_A_MISSING_NOTE =
        "Údaje o stavbě platné ke dni podpisu nejsou u záznamu uloženy: záznam nelze ověřit. Název stavby a adresa jsou z dnešního stavu stavby."

    /** Printed in place of the signer of a signature of format 3 that lost the signer's name or number. */
    internal const val SIGNER_MISSING = "jméno nebo číslo ČKAIT podepisujícího není uloženo: záznam nelze ověřit"

    /** The signer as the signature stored them (format 3), cut like [personOf] cuts an account: the signature block has a known height. */
    private fun storedSignerOf(report: DailyReportsRecord): String {
        val name = report.get(DAILY_REPORTS.SIGNERNAME)?.trim().orEmpty()
        val ckait = report.get(DAILY_REPORTS.SIGNERCKAITNUMBER)?.trim().orEmpty()
        if (name.isEmpty() || ckait.isEmpty()) return SIGNER_MISSING
        return "${shortened(name, SIGNER_NAME_LIMIT)}, ČKAIT ${shortened(ckait, SIGNER_CKAIT_LIMIT)}"
    }

    /** One reader for what is stored as JSON text; built once. */
    private val lenientJson = AppJson.lenient

    private fun weatherOf(report: org.jooq.Record): String = WeatherData.fromStored(report.get(DAILY_REPORTS.WEATHER)?.data())?.describe() ?: "Neuvedeno"

    // ---- how much text the document prints (see PrintBudget) --------------------------------------------------------

    /**
     * The budget of the texts of the entry: the construction object, the workers, the work description and the nine fields. A text of
     * nothing but line breaks is about 50 lines to a page, so this is some 80 pages at most; an entry of ordinary text, even of the longest
     * the fields hold, is a tenth of it.
     */
    internal const val ENTRY_BUDGET_LINES = 4000

    /** The most lines one text of the entry may take; a field of 5 000 characters is some 90 lines of prose, and 400 of a list of short items. */
    internal const val ENTRY_FIELD_CAP_LINES = 1000

    /** The budget of the addenda and the entries of other parties together, and the most lines one record may take. */
    internal const val RECORDS_BUDGET_LINES = 3000
    private const val RECORD_CAP_LINES = 1000

    /** What a record costs besides its text (the line with its author, and the space after it). */
    private const val RECORD_FIXED_LINES = 3

    /** The most records of each kind that are read for the document (a person may write any number of addenda). */
    private const val RECORDS_READ_LIMIT = 500

    /** How many characters a line holds, for the place a text is printed in; deliberately a little less than it does, so that a text is never more lines than counted. */
    private const val FULL_WIDTH_CHARS = 60
    private const val NARROW_COLUMN_CHARS = 30
    private const val WIDE_CELL_CHARS = 40
    private const val METER_CELL_CHARS = 20

    /**
     * The workers by trade: the trade and the names of each, cut to the budget of the entry. The people are counted by `count`, not by
     * what is printed; every row stays (there are at most 50), only its text is cut. The second value is the sentence about what was cut.
     */
    private fun workersOf(report: org.jooq.Record, budget: PrintBudget): Pair<List<WorkerPdf>, String> {
        var omitted = 0
        val workers = report.get(DAILY_REPORTS.WORKERSBYTRADE)?.data()
            ?.let { raw -> runCatching { lenientJson.decodeFromString(ListSerializer(WorkerEntry.serializer()), raw) }.getOrNull() }
            ?.map { worker ->
                val trade = budget.take(worker.trade, NARROW_COLUMN_CHARS, cap = 3)
                val names = budget.take(worker.names.joinToString("; "), NARROW_COLUMN_CHARS, cap = 100)
                omitted += trade.omitted + names.omitted
                WorkerPdf(trade.shown, worker.count, names.shown)
            }
            .orEmpty()
        return workers to PrintBudget.omittedLines(omitted)
    }

    /**
     * Every field of the entry in its fixed order, cut to the budget of the entry; one that says nothing has an empty text, which the
     * template prints as "bez záznamu".
     */
    private fun detailsOf(report: DailyReportsRecord, budget: PrintBudget): List<DetailPdf> =
        EntryDetails.valuesOf(report).map { (field, text) ->
            if (text == null) DetailPdf(field.label, "")
            else budget.take(text, FULL_WIDTH_CHARS, ENTRY_FIELD_CAP_LINES).let { DetailPdf(field.label, it.shown, PrintBudget.omittedLines(it.omitted)) }
        }

    /** The photos that are part of the entry (a removed photo is not), oldest first; the uploader is the name stored at upload. */
    private fun photosOf(tx: DSLContext, reportId: UUID): List<PhotoPdf> =
        tx.select(PHOTOS.UPLOADEDBYNAME, PHOTOS.CREATEDAT, PHOTOS.SHA256)
            .from(PHOTOS)
            .where(PHOTOS.REPORTID.eq(reportId).and(PHOTOS.DELETEDAT.isNull))
            .orderBy(PHOTOS.CREATEDAT.asc(), PHOTOS.ID.asc())
            .fetch()
            .map { PhotoPdf(it.get(PHOTOS.UPLOADEDBYNAME) ?: "", it.get(PHOTOS.CREATEDAT)?.let { at -> CzechFormat.dateTime(at) } ?: "", it.get(PHOTOS.SHA256).orEmpty()) }

    /**
     * The hash of the `report.lock` row of the audit chain that recorded the signature of this entry, or empty when there is none
     * (an entry signed before the audit trail existed, test data only). An entry is signed once, so there is one such row.
     */
    private fun lockRowHashOf(tx: DSLContext, reportId: UUID): String =
        tx.select(AUDIT_LOG.ROW_HASH)
            .from(AUDIT_LOG)
            .where(AUDIT_LOG.ACTION.eq("report.lock").and(AUDIT_LOG.ENTITY_TYPE.eq("report")).and(AUDIT_LOG.ENTITY_ID.eq(reportId.toString())))
            .orderBy(AUDIT_LOG.ID.asc())
            .limit(1)
            .fetchOne(AUDIT_LOG.ROW_HASH)
            .orEmpty()

    /** Who took note, with the name and the ČKAIT number the person had at that moment (stored with the acknowledgement), and the role. */
    private fun acknowledgementsOf(tx: DSLContext, reportId: UUID): List<AcknowledgementPdf> =
        tx.select(REPORT_ACKNOWLEDGEMENTS.USERNAME, REPORT_ACKNOWLEDGEMENTS.USERCKAITNUMBER, REPORT_ACKNOWLEDGEMENTS.ROLE, REPORT_ACKNOWLEDGEMENTS.CREATEDAT)
            .from(REPORT_ACKNOWLEDGEMENTS)
            .where(REPORT_ACKNOWLEDGEMENTS.REPORTID.eq(reportId))
            .orderBy(REPORT_ACKNOWLEDGEMENTS.CREATEDAT.asc(), REPORT_ACKNOWLEDGEMENTS.ID.asc())
            .fetch()
            .map {
                val role = if (it.get(REPORT_ACKNOWLEDGEMENTS.ROLE) == cz.stavebni.denik.jooq.enums.Role.INVESTOR) "stavebník" else "dozor"
                val person = identityLine(it.get(REPORT_ACKNOWLEDGEMENTS.USERNAME), it.get(REPORT_ACKNOWLEDGEMENTS.USERCKAITNUMBER))
                AcknowledgementPdf("$person ($role)", it.get(REPORT_ACKNOWLEDGEMENTS.CREATEDAT)?.let { at -> CzechFormat.dateTime(at) } ?: "")
            }

    /** The records that were printed, and how many more there were and did not fit the budget. */
    private class Printed<T>(val records: List<T>, val leftOut: Int)

    /**
     * The records of [rows] (at most [RECORDS_READ_LIMIT] are read; [total] is how many there are) made into what the document prints, in
     * order, while the budget lasts: each costs [RECORD_FIXED_LINES] and the lines of its text. The records after the one that does not fit are
     * left out and counted, and so are those that were not read.
     */
    private fun <T> printRecords(rows: List<org.jooq.Record>, total: Int, budget: PrintBudget, text: (org.jooq.Record) -> String, make: (org.jooq.Record, PrintBudget.Fitted) -> T): Printed<T> {
        val printed = mutableListOf<T>()
        for (row in rows) {
            if (!budget.spend(RECORD_FIXED_LINES)) break
            printed += make(row, budget.take(text(row), FULL_WIDTH_CHARS, RECORD_CAP_LINES))
        }
        return Printed(printed, total - printed.size)
    }

    /** The addenda with the name and the ČKAIT number their authors had when they wrote them (stored with the addendum), within [budget]. */
    private fun addendaOf(tx: DSLContext, reportId: UUID, budget: PrintBudget): Printed<AddendumPdf> =
        printRecords(
            tx.select(ADDENDA.AUTHORNAME, ADDENDA.AUTHORCKAITNUMBER, ADDENDA.CREATEDAT, ADDENDA.TEXT)
                .from(ADDENDA)
                .where(ADDENDA.REPORTID.eq(reportId))
                .orderBy(ADDENDA.CREATEDAT.asc(), ADDENDA.ID.asc())
                .limit(RECORDS_READ_LIMIT)
                .fetch(),
            tx.fetchCount(ADDENDA, ADDENDA.REPORTID.eq(reportId)), budget,
            text = { it.get(ADDENDA.TEXT) ?: "" },
        ) { row, fitted ->
            AddendumPdf(
                identityLine(row.get(ADDENDA.AUTHORNAME), row.get(ADDENDA.AUTHORCKAITNUMBER)),
                row.get(ADDENDA.CREATEDAT)?.let { at -> CzechFormat.dateTime(at) } ?: "", fitted.shown, PrintBudget.omittedLines(fitted.omitted),
            )
        }

    /** The entries of other parties with the name and the ČKAIT number of whoever wrote them (the manager, for an outside party), as stored with the entry, within [budget]. */
    private fun remarksOf(tx: DSLContext, reportId: UUID, budget: PrintBudget): Printed<RemarkPdf> =
        printRecords(
            tx.select(REMARKS.AUTHORNAME, REMARKS.AUTHORCKAITNUMBER, REMARKS.EXTERNALAUTHOR, REMARKS.CREATEDAT, REMARKS.TEXT)
                .from(REMARKS)
                .where(REMARKS.REPORTID.eq(reportId))
                .orderBy(REMARKS.CREATEDAT.asc(), REMARKS.ID.asc())
                .limit(RECORDS_READ_LIMIT)
                .fetch(),
            tx.fetchCount(REMARKS, REMARKS.REPORTID.eq(reportId)), budget,
            text = { it.get(REMARKS.TEXT) ?: "" },
        ) { row, fitted ->
            RemarkPdf(
                identityLine(row.get(REMARKS.AUTHORNAME), row.get(REMARKS.AUTHORCKAITNUMBER)), row.get(REMARKS.EXTERNALAUTHOR) ?: "",
                row.get(REMARKS.CREATEDAT)?.let { at -> CzechFormat.dateTime(at) } ?: "", fitted.shown, PrintBudget.omittedLines(fitted.omitted),
            )
        }

    // ---- the handover of the site (příloha 12 B.2 a)) ---------------------------------------------------------

    /**
     * The most handover protocols the document prints; a project does not make this many (a handover of the site, of the networks, of
     * the work). The rest is counted, not hidden.
     */
    internal const val MAX_HANDOVERS = 50

    /**
     * The budget of the whole section, in lines of text ([PrintBudget]): the protocols are printed one after the other, each with its fixed
     * part and its text, while it lasts. A protocol of a normal size is a few dozen lines, so fifty of them fit; the largest that the limits
     * at the time of saving allow (100 lines of participants, 200 of notes, 50 meters of three fields of 100 characters) is some 560, so nine
     * of those fit, and the rest are counted and named. What is stored past those limits is cut to the budget with a sentence. Measured with
     * the real typst, the section is at most about a hundred pages whatever is stored (`RealTypstHandoversPdfTest`).
     */
    internal const val HANDOVER_BUDGET_LINES = 5000

    /** What a protocol costs besides its text: the heading, the table of its content, the block of the signatures and the space round them. */
    private const val PROTOCOL_FIXED_LINES = 14

    /** The most lines of a type, of participants and of notes, and of one field of a meter, that a protocol prints (the limits at the time of saving, with room for the wrapping of a long line). */
    private const val TYPE_CAP_LINES = 3
    private const val PARTICIPANTS_CAP_LINES = 150
    private const val NOTES_CAP_LINES = 330
    private const val METER_FIELD_CAP_LINES = 6

    private fun stateWords(state: SiteHandoverState): String = when (state) {
        SiteHandoverState.DRAFT -> "nepodepsáno"
        SiteHandoverState.SIGNED_BY_CONTRACTOR -> "zatím podepsáno jen stranou zhotovitele"
        SiteHandoverState.SIGNED_BY_CLIENT -> "zatím podepsáno jen stranou stavebníka"
        SiteHandoverState.COMPLETE -> "podepsáno oběma stranami"
    }

    /** What the section says before the protocols: which state it describes, and that the protocols have signatures of their own. */
    internal fun handoversNote(signed: Boolean): String =
        if (signed) {
            "Protokoly o předání a převzetí staveniště mají vlastní podpisy obou stran a nejsou součástí podpisu tohoto záznamu. " +
                "Uveden je stav ke dni podpisu záznamu: protokoly, které tehdy už některá strana podepsala, a podpisy, které tehdy existovaly; " +
                "co přibylo později, se zde netiskne."
        } else {
            "Protokoly o předání a převzetí staveniště mají vlastní podpisy obou stran. Záznam ještě není podepsán, proto jsou uvedeny " +
                "všechny protokoly stavby tak, jak jsou nyní, i ty, které ještě nikdo nepodepsal."
        }

    /** The role a signer held in the project, as the document says it. */
    private fun roleWords(role: cz.stavebni.denik.jooq.enums.Role?): String = when (role) {
        cz.stavebni.denik.jooq.enums.Role.BOSS -> "stavbyvedoucí"
        cz.stavebni.denik.jooq.enums.Role.INSPECTOR -> "technický dozor"
        cz.stavebni.denik.jooq.enums.Role.INVESTOR -> "stavebník"
        cz.stavebni.denik.jooq.enums.Role.WORKER -> "pracovník"
        null -> ""
    }

    private fun handoverSignatureOf(signature: SiteHandoverSignaturesRecord): HandoverSignaturePdf {
        val name = shortened(signature.signername.orEmpty().trim(), SIGNER_NAME_LIMIT)
        val ckait = signature.signerckaitnumber?.trim().orEmpty().ifEmpty { null }?.let { "ČKAIT ${shortened(it, SIGNER_CKAIT_LIMIT)}" }
        return HandoverSignaturePdf(
            signedBy = listOfNotNull(name.ifEmpty { null }, roleWords(signature.signerrole).ifEmpty { null }, ckait).joinToString(", "),
            at = signature.signedat?.let { CzechFormat.dateTime(it) } ?: "",
            signatureHash = signature.signaturehash.orEmpty(),
        )
    }

    private fun metersOf(record: org.jooq.Record): List<MeterPdf> =
        record.get(SITE_HANDOVERS.METERSTATES)?.data()
            ?.let { raw ->
                runCatching { lenientJson.decodeFromString(ListSerializer(MeterState.serializer()), raw) }
                    .onFailure { log.warn("The meters of handover protocol {} are not readable: {}", record.get(SITE_HANDOVERS.ID), it.javaClass.simpleName) }
                    .getOrNull()
            }
            ?.map { MeterPdf(it.medium, it.serialNumber, it.state) }
            .orEmpty()

    /** The protocols the document prints, and how many more belong to the entry and are left out. */
    private class HandoverSection(val handovers: List<HandoverPdf>, val leftOut: Int)

    /**
     * The handover protocols of [projectId] that belong to an entry (backlog B9).
     *
     * - [signedAt] null (a draft): every protocol that is not deleted, with the state it has now, also one that nobody has signed.
     * - [signedAt] (a signed entry): the protocols that had a signature at that moment or before it, and of each only the signatures
     *   made then or before: the state of the protocol on the day of the entry. A protocol that came later, and a signature that
     *   came later, are never printed as if they had been there.
     *
     * Reading the live rows is safe for a signed entry: the content of a protocol is frozen from its first signature (V5), a signature
     * is stamped with the time it was inserted and is never changed, and a protocol with a signature cannot be deleted, so what is
     * printed for a given entry does not change over time. The order is the day of the handover, then the order they were made in.
     */
    private fun handoversOf(tx: DSLContext, projectId: UUID, signedAt: OffsetDateTime?): HandoverSection {
        val thatDay = if (signedAt == null) DSL.noCondition() else SITE_HANDOVER_SIGNATURES.SIGNEDAT.le(signedAt)
        val belongs = SITE_HANDOVERS.PROJECTID.eq(projectId).and(SITE_HANDOVERS.DELETEDAT.isNull).and(
            if (signedAt == null) DSL.noCondition()
            else DSL.exists(
                DSL.selectOne().from(SITE_HANDOVER_SIGNATURES).where(SITE_HANDOVER_SIGNATURES.HANDOVERID.eq(SITE_HANDOVERS.ID)).and(thatDay),
            ),
        )
        val total = tx.fetchCount(SITE_HANDOVERS, belongs)
        val records = tx.selectFrom(SITE_HANDOVERS)
            .where(belongs)
            .orderBy(SITE_HANDOVERS.DATE.asc(), SITE_HANDOVERS.CREATEDAT.asc(), SITE_HANDOVERS.ID.asc())
            .limit(MAX_HANDOVERS)
            .fetch()
        val signatures = if (records.isEmpty()) emptyMap() else {
            tx.selectFrom(SITE_HANDOVER_SIGNATURES)
                .where(SITE_HANDOVER_SIGNATURES.HANDOVERID.`in`(records.mapNotNull { it.id }))
                .and(thatDay)
                .orderBy(SITE_HANDOVER_SIGNATURES.SIGNEDAT.asc(), SITE_HANDOVER_SIGNATURES.ID.asc())
                .fetch()
                .groupBy { it.handoverid!! }
        }
        val budget = PrintBudget(HANDOVER_BUDGET_LINES)
        val printed = mutableListOf<HandoverPdf>()
        for (record in records) {
            // The protocols that come after the one that does not fit are counted, not printed (and a smaller one is not slipped in before them).
            if (!budget.spend(PROTOCOL_FIXED_LINES)) break
            val ofRecord = signatures[record.id].orEmpty()
            val contractor = ofRecord.firstOrNull { it.side == HandoverSide.CONTRACTOR.name }
            val client = ofRecord.firstOrNull { it.side == HandoverSide.CLIENT.name }
            val type = budget.take(record.type.orEmpty(), WIDE_CELL_CHARS, TYPE_CAP_LINES)
            val participants = budget.take(record.participants.orEmpty(), WIDE_CELL_CHARS, PARTICIPANTS_CAP_LINES)
            val notes = budget.take(record.notes.orEmpty(), WIDE_CELL_CHARS, NOTES_CAP_LINES)
            var omitted = type.omitted + participants.omitted + notes.omitted
            val meters = metersOf(record)
            val printedMeters = mutableListOf<MeterPdf>()
            for ((index, meter) in meters.withIndex()) {
                val row = budget.row(listOf(meter.medium, meter.serialNumber, meter.state), METER_CELL_CHARS, METER_FIELD_CAP_LINES)
                if (row == null) {
                    // What is left of the meters is at least a line each.
                    omitted += meters.size - index
                    break
                }
                omitted += row.omitted
                printedMeters += MeterPdf(row.cells[0], row.cells[1], row.cells[2])
            }
            printed += HandoverPdf(
                date = record.date?.let { at -> Dates.format(at) }?.let { day -> runCatching { CzechFormat.date(LocalDate.parse(day)) }.getOrDefault(day) } ?: "",
                type = type.shown,
                participants = participants.shown,
                notes = notes.shown,
                meters = printedMeters,
                cut = PrintBudget.omittedLines(omitted),
                state = stateWords(
                    when {
                        contractor != null && client != null -> SiteHandoverState.COMPLETE
                        contractor != null -> SiteHandoverState.SIGNED_BY_CONTRACTOR
                        client != null -> SiteHandoverState.SIGNED_BY_CLIENT
                        else -> SiteHandoverState.DRAFT
                    },
                ),
                // Both sides signed the same content, so the first signature says what it was.
                contentHash = ofRecord.firstOrNull()?.contenthash.orEmpty(),
                contractor = contractor?.let { handoverSignatureOf(it) },
                client = client?.let { handoverSignatureOf(it) },
            )
        }
        return HandoverSection(printed, total - printed.size)
    }

    private fun loadData(tx: DSLContext, reportId: UUID): ReportPdfData {
        val report = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .fetchOne() ?: throw NotFoundException("Záznam nenalezen")

        val project = tx.selectFrom(PROJECTS)
            .where(PROJECTS.ID.eq(report.get(DAILY_REPORTS.PROJECTID)))
            .fetchOne() ?: throw NotFoundException("Projekt nenalezen")

        val day = checkNotNull(report.get(DAILY_REPORTS.DATE)) { "the date of an entry is NOT NULL" }
        val lockedAt = report.get(DAILY_REPORTS.LOCKEDAT)
        val signedAt = report.get(DAILY_REPORTS.SIGNEDAT)
        val signatureFormat = if (lockedAt != null) report.get(DAILY_REPORTS.SIGNATUREFORMAT)?.toInt() else null

        // Part A. A signature of format 3 stored it with the entry (the identification as it was on the day of signing), and that
        // is what is printed; a draft and an older entry have none, and the project as it stands now is printed, as it always was.
        // A format 3 entry whose snapshot is gone is not given today's data in its place: it is a failure of the signature.
        val frozen = signatureFormat != null && signatureFormat >= 3
        val storedPartA = if (frozen) report.get(DAILY_REPORTS.PARTASNAPSHOT)?.takeIf { it.isNotBlank() } else null
        val partA: PartA? = when {
            !frozen -> PartASnapshot.read(tx, report.get(DAILY_REPORTS.PROJECTID)!!)
            storedPartA == null -> null
            else -> runCatching { PartASnapshot.parse(storedPartA) }
                .onFailure { log.warn("The part A snapshot of report {} is not readable: {}", reportId, it.javaClass.simpleName) }
                .getOrNull()
        }
        val partAMissing = frozen && partA == null
        // A signed entry is given the protocols as they were at the moment it was signed (an entry signed before the time was kept
        // has the time of its lock).
        val handovers = handoversOf(tx, report.get(DAILY_REPORTS.PROJECTID)!!, if (lockedAt != null) signedAt ?: lockedAt else null)
        // The texts of the entry, in the order the document prints them, within one budget of lines; and the records written after the
        // signature within another (see PrintBudget: a text of nothing but line breaks is thousands of pages, and is never cut silently).
        val entryBudget = PrintBudget(ENTRY_BUDGET_LINES)
        val construction = entryBudget.take(report.get(DAILY_REPORTS.CONSTRUCTIONOBJ).orEmpty(), FULL_WIDTH_CHARS, cap = 5)
        val (workers, workersCut) = workersOf(report, entryBudget)
        val description = entryBudget.take(report.get(DAILY_REPORTS.WORKDESCRIPTION) ?: "", FULL_WIDTH_CHARS, ENTRY_FIELD_CAP_LINES)
        val details = detailsOf(report, entryBudget)
        val recordsBudget = PrintBudget(RECORDS_BUDGET_LINES)
        val addenda = addendaOf(tx, reportId, recordsBudget)
        val remarks = remarksOf(tx, reportId, recordsBudget)
        return ReportPdfData(
            // the page
            projectName = partA?.identification?.get("name") ?: project.get(PROJECTS.NAME) ?: "",
            address = partA?.identification?.get("address") ?: project.get(PROJECTS.ADDRESS) ?: "",
            date = CzechFormat.date(day),
            weekday = CzechFormat.weekday(day),
            sequenceNumber = report.get(DAILY_REPORTS.SEQUENCENUMBER),
            isSigned = lockedAt != null,
            // part A
            projectInfo = partA?.let { projectInfoOf(it) }.orEmpty(),
            projectInfoNote = when {
                partAMissing -> PART_A_MISSING_NOTE
                frozen -> projectInfoNoteFrozen(checkNotNull(signedAt) { "a signed entry has the time it was signed" })
                else -> projectInfoNote(Dates.today(), lockedAt, project.get(PROJECTS.UPDATEDAT))
            },
            subcontractors = partA?.identification?.get("subcontractors")?.trim().orEmpty(),
            supportingDocuments = partA?.identification?.get("supportingDocuments")?.trim().orEmpty(),
            managers = partA?.let { personsOf(it, "BOSS") }.orEmpty(),
            supervisors = partA?.let { personsOf(it, "INSPECTOR") }.orEmpty(),
            authorizedPersons = partA?.let { authorizedPersonsOf(it) }.orEmpty(),
            partASha256 = if (storedPartA != null && partA != null) PartASnapshot.sha256(storedPartA) else "",
            partAMissing = partAMissing,
            // part B
            // The name the account had when the entry was made, stored with it (backlog B9); the signature covers the author by id.
            author = report.get(DAILY_REPORTS.AUTHORNAME).orEmpty(),
            isLateEntry = report.get(DAILY_REPORTS.ISLATEENTRY) ?: false,
            lateEntryReason = report.get(DAILY_REPORTS.LATEENTRYREASON) ?: "",
            isControlDay = report.get(DAILY_REPORTS.ISCONTROLDAY) ?: false,
            constructionObj = construction.shown,
            constructionObjCut = PrintBudget.omittedLines(construction.omitted),
            weather = weatherOf(report),
            workers = workers,
            workersCut = workersCut,
            workDescription = description.shown,
            workDescriptionCut = PrintBudget.omittedLines(description.omitted),
            details = details,
            photos = photosOf(tx, reportId),
            // the signature
            entryId = reportId.toString(),
            // From format 3 on the signer is what the signature stored; before, the account as it is now (the entry did not keep it).
            signedBy = if (frozen) storedSignerOf(report)
            else personOf(tx, report.get(DAILY_REPORTS.SIGNEDBYID), withCkait = true, nameLimit = SIGNER_NAME_LIMIT, ckaitLimit = SIGNER_CKAIT_LIMIT),
            signatureFormat = signatureFormat,
            signedAt = signedAt?.let { CzechFormat.dateTime(it) } ?: "",
            signatureHash = report.get(DAILY_REPORTS.SIGNATUREHASH) ?: "",
            auditRowHash = if (lockedAt != null) lockRowHashOf(tx, reportId) else "",
            // the handover of the site: for a signed entry as it stood when it was signed
            handovers = handovers.handovers,
            handoversNote = handoversNote(signed = lockedAt != null),
            handoversLeftOut = handovers.leftOut,
            handoversLeftOutNote = PrintBudget.omittedProtocols(handovers.leftOut),
            // after the signature
            addenda = addenda.records,
            remarks = remarks.records,
            recordsLeftOutNote = PrintBudget.omittedRecords(addenda.leftOut + remarks.leftOut),
            acknowledgements = acknowledgementsOf(tx, reportId),
        )
    }

    /**
     * One private directory per request: nothing is shared between exports and nothing is left behind. Internal so that the
     * layout tests can render data made by hand, without a database (the render slots are taken by [generateReportPdf]).
     */
    internal fun render(data: ReportPdfData, reportId: UUID): PdfDocument {
        val dir = Files.createTempDirectory("denik-pdf-").toFile()
        try {
            val typstFile = File(dir, "main.typ").apply { writeText(template, StandardCharsets.UTF_8) }
            File(dir, "data.json").writeText(json.encodeToString(ReportPdfData.serializer(), data), StandardCharsets.UTF_8)
            val pdfFile = File(dir, "out.pdf")

            try {
                compiler.compile(dir, typstFile, pdfFile)
            } catch (e: PdfExportException) {
                log.warn("PDF export of report {} failed: {}", reportId, e.message)
                throw e
            }

            val bytes = pdfFile.takeIf { it.isFile }?.readBytes()
                ?: throw PdfExportException("typst produced no output file")
            if (bytes.size < 5 || String(bytes, 0, 5, StandardCharsets.ISO_8859_1) != "%PDF-") {
                throw PdfExportException("typst output is not a PDF")
            }
            return PdfDocument("report_$reportId.pdf", bytes)
        } finally {
            dir.deleteRecursively()
        }
    }
}
