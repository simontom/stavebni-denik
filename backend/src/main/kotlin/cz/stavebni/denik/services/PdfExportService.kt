package cz.stavebni.denik.services

import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.domain.WorkerEntry
import cz.stavebni.denik.jooq.tables.records.DailyReportsRecord
import cz.stavebni.denik.jooq.tables.references.*
import cz.stavebni.denik.util.CzechFormat
import cz.stavebni.denik.util.Dates
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.jooq.DSLContext
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

    private val json = Json { encodeDefaults = true }

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

    /** A calendar day of part A (`YYYY-MM-DD`: the date of a permit or a contract) in Czech form. */
    private fun partADay(value: String?): String? = value?.let { runCatching { CzechFormat.date(LocalDate.parse(it)) }.getOrDefault(it) }

    /**
     * Part A: the identification of the diary as labelled rows; a row without a value is left out. A number and its date share a
     * row. [partA] is the snapshot stored with the signature (format 3) or part A as it stands now: the rows are the same.
     */
    private fun projectInfoOf(partA: PartA): List<LabeledPdf> {
        val identification = partA.identification
        fun text(key: String) = identification[key]?.trim().orEmpty()
        fun numbered(number: String, date: String): String =
            listOfNotNull(number.ifEmpty { null }, partADay(date.ifEmpty { null })?.let { "ze dne $it" }).joinToString(" ")
        fun person(name: String, ckait: String?): String = listOfNotNull(name.ifEmpty { null }, ckait?.let { "ČKAIT $it" }).joinToString(", ")
        // The author's supervision (příloha 12 A e)): who it is, and the number of their authorisation.
        val supervision = listOfNotNull(text("authorSupervisionName").ifEmpty { null }, text("authorSupervisionAuthorization").ifEmpty { null }?.let { "autorizace $it" }).joinToString(", ")
        return listOf(
            "Katastrální území" to text("cadastralArea"),
            "Parcelní čísla" to text("parcelNumbers"),
            "Stavebník" to text("builder"),
            "Zhotovitel" to text("contractor"),
            "Stavbyvedoucí" to person(partA.siteManager.name, partA.siteManager.ckaitNumber),
            "Projektant" to text("designerName"),
            "Autorský dozor" to supervision,
            "Povolení" to numbered(text("permitNumber"), text("permitDate")),
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
    private val lenientJson = Json { ignoreUnknownKeys = true }

    private fun weatherOf(report: org.jooq.Record): String = WeatherData.fromStored(report.get(DAILY_REPORTS.WEATHER)?.data())?.describe() ?: "Neuvedeno"

    private fun workersOf(report: org.jooq.Record): List<WorkerPdf> =
        report.get(DAILY_REPORTS.WORKERSBYTRADE)?.data()
            ?.let { raw -> runCatching { lenientJson.decodeFromString(ListSerializer(WorkerEntry.serializer()), raw) }.getOrNull() }
            ?.map { WorkerPdf(it.trade, it.count, it.names.joinToString("; ")) }
            .orEmpty()

    /** Every field of the entry in its fixed order; one that says nothing has an empty text, which the template prints as "bez záznamu". */
    private fun detailsOf(report: DailyReportsRecord): List<DetailPdf> =
        EntryDetails.valuesOf(report).map { (field, text) -> DetailPdf(field.label, text.orEmpty()) }

    /** The photos that are part of the entry (a removed photo is not), oldest first. */
    private fun photosOf(tx: DSLContext, reportId: UUID): List<PhotoPdf> =
        tx.select(USERS.DISPLAYNAME, PHOTOS.CREATEDAT, PHOTOS.SHA256)
            .from(PHOTOS)
            .join(USERS).on(USERS.ID.eq(PHOTOS.UPLOADEDBYID))
            .where(PHOTOS.REPORTID.eq(reportId).and(PHOTOS.DELETEDAT.isNull))
            .orderBy(PHOTOS.CREATEDAT.asc(), PHOTOS.ID.asc())
            .fetch()
            .map { PhotoPdf(it.get(USERS.DISPLAYNAME) ?: "", it.get(PHOTOS.CREATEDAT)?.let { at -> CzechFormat.dateTime(at) } ?: "", it.get(PHOTOS.SHA256).orEmpty()) }

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

    private fun acknowledgementsOf(tx: DSLContext, reportId: UUID): List<AcknowledgementPdf> =
        tx.select(USERS.DISPLAYNAME, REPORT_ACKNOWLEDGEMENTS.ROLE, REPORT_ACKNOWLEDGEMENTS.CREATEDAT)
            .from(REPORT_ACKNOWLEDGEMENTS)
            .join(USERS).on(USERS.ID.eq(REPORT_ACKNOWLEDGEMENTS.USERID))
            .where(REPORT_ACKNOWLEDGEMENTS.REPORTID.eq(reportId))
            .orderBy(REPORT_ACKNOWLEDGEMENTS.CREATEDAT.asc(), REPORT_ACKNOWLEDGEMENTS.ID.asc())
            .fetch()
            .map {
                val role = if (it.get(REPORT_ACKNOWLEDGEMENTS.ROLE) == cz.stavebni.denik.jooq.enums.Role.INVESTOR) "stavebník" else "dozor"
                AcknowledgementPdf("${it.get(USERS.DISPLAYNAME) ?: ""} ($role)", it.get(REPORT_ACKNOWLEDGEMENTS.CREATEDAT)?.let { at -> CzechFormat.dateTime(at) } ?: "")
            }

    private fun addendaOf(tx: DSLContext, reportId: UUID): List<AddendumPdf> =
        tx.select(USERS.DISPLAYNAME, ADDENDA.CREATEDAT, ADDENDA.TEXT)
            .from(ADDENDA)
            .join(USERS).on(USERS.ID.eq(ADDENDA.AUTHORID))
            .where(ADDENDA.REPORTID.eq(reportId))
            .orderBy(ADDENDA.CREATEDAT.asc(), ADDENDA.ID.asc())
            .fetch()
            .map { AddendumPdf(it.get(USERS.DISPLAYNAME) ?: "", it.get(ADDENDA.CREATEDAT)?.let { at -> CzechFormat.dateTime(at) } ?: "", it.get(ADDENDA.TEXT) ?: "") }

    private fun remarksOf(tx: DSLContext, reportId: UUID): List<RemarkPdf> =
        tx.select(USERS.DISPLAYNAME, REMARKS.EXTERNALAUTHOR, REMARKS.CREATEDAT, REMARKS.TEXT)
            .from(REMARKS)
            .join(USERS).on(USERS.ID.eq(REMARKS.AUTHORID))
            .where(REMARKS.REPORTID.eq(reportId))
            .orderBy(REMARKS.CREATEDAT.asc(), REMARKS.ID.asc())
            .fetch()
            .map { RemarkPdf(it.get(USERS.DISPLAYNAME) ?: "", it.get(REMARKS.EXTERNALAUTHOR) ?: "", it.get(REMARKS.CREATEDAT)?.let { at -> CzechFormat.dateTime(at) } ?: "", it.get(REMARKS.TEXT) ?: "") }

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
            author = personOf(tx, report.get(DAILY_REPORTS.AUTHORID)),
            isLateEntry = report.get(DAILY_REPORTS.ISLATEENTRY) ?: false,
            lateEntryReason = report.get(DAILY_REPORTS.LATEENTRYREASON) ?: "",
            isControlDay = report.get(DAILY_REPORTS.ISCONTROLDAY) ?: false,
            constructionObj = report.get(DAILY_REPORTS.CONSTRUCTIONOBJ).orEmpty(),
            weather = weatherOf(report),
            workers = workersOf(report),
            workDescription = report.get(DAILY_REPORTS.WORKDESCRIPTION) ?: "",
            details = detailsOf(report),
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
            // after the signature
            addenda = addendaOf(tx, reportId),
            remarks = remarksOf(tx, reportId),
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
