package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
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
    val sequenceNumber: Int,
    val weather: String,
    val workDescription: String,
    val isSigned: Boolean,
    val isLateEntry: Boolean,
    val lateEntryReason: String,
)

object PdfExportService {
    private val log = LoggerFactory.getLogger(PdfExportService::class.java)

    @Volatile
    var compiler: TypstCompiler = ProcessTypstCompiler()

    /** At most two PDFs are rendered at the same time; the others wait. */
    private val slots = Semaphore(2)

    /** The fixed template. It contains no user text (see the comment in the file). */
    internal val template: String by lazy {
        PdfExportService::class.java.getResourceAsStream("/pdf/report.typ")!!
            .use { it.readBytes().toString(StandardCharsets.UTF_8) }
    }

    private val json = Json { encodeDefaults = true }

    suspend fun generateReportPdf(tx: DSLContext, reportId: UUID): PdfDocument {
        val data = loadData(tx, reportId)
        return slots.withPermit {
            withContext(Dispatchers.IO) { render(data, reportId) }
        }
    }

    private fun loadData(tx: DSLContext, reportId: UUID): ReportPdfData {
        val report = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")

        val project = tx.selectFrom(PROJECTS)
            .where(PROJECTS.ID.eq(report.get(DAILY_REPORTS.PROJECTID)))
            .fetchOne() ?: throw IllegalArgumentException("Project not found")

        return ReportPdfData(
            projectName = project.get(PROJECTS.NAME) ?: "",
            address = project.get(PROJECTS.ADDRESS) ?: "",
            date = report.get(DAILY_REPORTS.DATE).toString(),
            sequenceNumber = report.get(DAILY_REPORTS.SEQUENCENUMBER) ?: 0,
            weather = report.get(DAILY_REPORTS.WEATHER)?.data()
                ?.let { raw -> runCatching { Json { ignoreUnknownKeys = true }.decodeFromString(cz.stavebni.denik.domain.WeatherData.serializer(), raw) }.getOrNull() }
                ?.takeUnless { it.isEmpty() }?.describe() ?: "Neuvedeno",
            workDescription = report.get(DAILY_REPORTS.WORKDESCRIPTION) ?: "",
            isSigned = report.get(DAILY_REPORTS.LOCKEDAT) != null,
            isLateEntry = report.get(DAILY_REPORTS.ISLATEENTRY) ?: false,
            lateEntryReason = report.get(DAILY_REPORTS.LATEENTRYREASON) ?: "",
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
