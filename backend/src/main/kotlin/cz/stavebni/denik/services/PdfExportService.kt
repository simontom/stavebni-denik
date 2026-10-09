package cz.stavebni.denik.services

import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.jooq.tables.references.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jooq.DSLContext
import org.slf4j.LoggerFactory
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Duration
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

/** What the fixed template shows. Everything user-controlled travels in here, never in the template. */
@Serializable
internal data class ReportPdfData(
    val projectName: String,
    val address: String,
    val date: String,
    /** Null while the entry is a draft: the number is given at signing (decision D11). */
    val sequenceNumber: Int?,
    val weather: String,
    val workDescription: String,
    val isSigned: Boolean,
    val isLateEntry: Boolean,
    val lateEntryReason: String,
    /** Who signed ("Name, ČKAIT 123") and when; empty while the entry is not signed. */
    val signedBy: String,
    val signedAt: String,
    /** SHA-256 of the entry's content at signing (see ReportSignature); empty for an unsigned entry. */
    val signatureHash: String,
    /** The addenda of a signed entry, oldest first. */
    val addenda: List<AddendumPdf> = emptyList(),
    /** The entries of other parties, oldest first. */
    val remarks: List<RemarkPdf> = emptyList(),
    /** Who took note of the signed entry ("Name (role)"), with the time, oldest first. */
    val acknowledgements: List<AcknowledgementPdf> = emptyList(),
)

@Serializable
internal data class AcknowledgementPdf(val who: String, val at: String)

@Serializable
internal data class RemarkPdf(val author: String, val onBehalfOf: String, val at: String, val text: String)

@Serializable
internal data class AddendumPdf(val author: String, val at: String, val text: String)

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

    private fun loadData(tx: DSLContext, reportId: UUID): ReportPdfData {
        val report = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .fetchOne() ?: throw NotFoundException("Záznam nenalezen")

        val project = tx.selectFrom(PROJECTS)
            .where(PROJECTS.ID.eq(report.get(DAILY_REPORTS.PROJECTID)))
            .fetchOne() ?: throw NotFoundException("Projekt nenalezen")

        return ReportPdfData(
            projectName = project.get(PROJECTS.NAME) ?: "",
            address = project.get(PROJECTS.ADDRESS) ?: "",
            date = report.get(DAILY_REPORTS.DATE).toString(),
            sequenceNumber = report.get(DAILY_REPORTS.SEQUENCENUMBER),
            weather = report.get(DAILY_REPORTS.WEATHER)?.data()
                ?.let { raw -> runCatching { Json { ignoreUnknownKeys = true }.decodeFromString(cz.stavebni.denik.domain.WeatherData.serializer(), raw) }.getOrNull() }
                ?.takeUnless { it.isEmpty() }?.describe() ?: "Neuvedeno",
            workDescription = report.get(DAILY_REPORTS.WORKDESCRIPTION) ?: "",
            isSigned = report.get(DAILY_REPORTS.LOCKEDAT) != null,
            isLateEntry = report.get(DAILY_REPORTS.ISLATEENTRY) ?: false,
            lateEntryReason = report.get(DAILY_REPORTS.LATEENTRYREASON) ?: "",
            signedBy = report.get(DAILY_REPORTS.SIGNEDBYID)?.let { id ->
                tx.select(USERS.DISPLAYNAME, USERS.CKAITNUMBER).from(USERS).where(USERS.ID.eq(id)).fetchOne()
                    ?.let { u -> listOfNotNull(u.get(USERS.DISPLAYNAME), u.get(USERS.CKAITNUMBER)?.takeIf { it.isNotBlank() }?.let { "ČKAIT $it" }).joinToString(", ") }
            } ?: "",
            signedAt = report.get(DAILY_REPORTS.SIGNEDAT)?.let { AuditHash.formatTs(it) } ?: "",
            signatureHash = report.get(DAILY_REPORTS.SIGNATUREHASH) ?: "",
            addenda = tx.select(USERS.DISPLAYNAME, ADDENDA.CREATEDAT, ADDENDA.TEXT)
                .from(ADDENDA)
                .join(USERS).on(USERS.ID.eq(ADDENDA.AUTHORID))
                .where(ADDENDA.REPORTID.eq(reportId))
                .orderBy(ADDENDA.CREATEDAT.asc(), ADDENDA.ID.asc())
                .fetch()
                .map { AddendumPdf(it.get(USERS.DISPLAYNAME) ?: "", it.get(ADDENDA.CREATEDAT)?.let { at -> AuditHash.formatTs(at) } ?: "", it.get(ADDENDA.TEXT) ?: "") },
            acknowledgements = tx.select(USERS.DISPLAYNAME, REPORT_ACKNOWLEDGEMENTS.ROLE, REPORT_ACKNOWLEDGEMENTS.CREATEDAT)
                .from(REPORT_ACKNOWLEDGEMENTS)
                .join(USERS).on(USERS.ID.eq(REPORT_ACKNOWLEDGEMENTS.USERID))
                .where(REPORT_ACKNOWLEDGEMENTS.REPORTID.eq(reportId))
                .orderBy(REPORT_ACKNOWLEDGEMENTS.CREATEDAT.asc(), REPORT_ACKNOWLEDGEMENTS.ID.asc())
                .fetch()
                .map {
                    val role = if (it.get(REPORT_ACKNOWLEDGEMENTS.ROLE) == cz.stavebni.denik.jooq.enums.Role.INVESTOR) "stavebník" else "dozor"
                    AcknowledgementPdf("${it.get(USERS.DISPLAYNAME) ?: ""} ($role)", it.get(REPORT_ACKNOWLEDGEMENTS.CREATEDAT)?.let { at -> AuditHash.formatTs(at) } ?: "")
                },
            remarks = tx.select(USERS.DISPLAYNAME, REMARKS.EXTERNALAUTHOR, REMARKS.CREATEDAT, REMARKS.TEXT)
                .from(REMARKS)
                .join(USERS).on(USERS.ID.eq(REMARKS.AUTHORID))
                .where(REMARKS.REPORTID.eq(reportId))
                .orderBy(REMARKS.CREATEDAT.asc(), REMARKS.ID.asc())
                .fetch()
                .map { RemarkPdf(it.get(USERS.DISPLAYNAME) ?: "", it.get(REMARKS.EXTERNALAUTHOR) ?: "", it.get(REMARKS.CREATEDAT)?.let { at -> AuditHash.formatTs(at) } ?: "", it.get(REMARKS.TEXT) ?: "") },
        )
    }

    /** One private directory per request: nothing is shared between exports and nothing is left behind. */
    private fun render(data: ReportPdfData, reportId: UUID): PdfDocument {
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
