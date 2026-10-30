package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File
import java.nio.file.Path
import java.time.Duration
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class PdfExportServiceTest : BaseIntegrationTest() {

    private suspend fun createReport(
        boss: SessionUser = createTestUser(role = Role.BOSS),
        projectName: String = "PDF Test Project",
        description: String = "Popis prací",
    ): UUID {
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = projectName, address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28", workDescription = description)
        return UUID.fromString(report.id)
    }

    // --- what typst is given -------------------------------------------------------------------

    @Test
    fun `the template is fixed and user text only travels in data json`() = runBlocking<Unit> {
        val hostileName = "#panic(\"x\") *Stavba*"
        val hostileText = "#read(\"/etc/passwd\")\n#include \"main.typ\"\n= nadpis"
        val reportId = createReport(projectName = hostileName, description = hostileText)

        var typst = ""
        var data = ""
        PdfExportService.compiler = TypstCompiler { dir, typstFile, pdfFile ->
            typst = typstFile.readText()
            data = File(dir, "data.json").readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }

        PdfExportService.generateReportPdf(dsl, reportId)

        assertEquals(PdfExportService.template, typst, "main.typ must be exactly the fixed template")
        assertFalse(typst.contains("panic"), "user text must not be part of the typst source")
        assertFalse(typst.contains("etc/passwd"), "user text must not be part of the typst source")

        val json = Json.parseToJsonElement(data).jsonObject
        assertEquals(hostileName, json["projectName"]!!.jsonPrimitive.content)
        assertEquals(hostileText, json["workDescription"]!!.jsonPrimitive.content)
        // Dates are for people: Czech, with the weekday (28 September 2026 is a Monday).
        assertEquals("28. 9. 2026", json["date"]!!.jsonPrimitive.content)
        assertEquals("pondělí", json["weekday"]!!.jsonPrimitive.content)
    }

    @Test
    fun `the note about the identification names days in Prague, not in UTC`() {
        val today = LocalDate.of(2026, 10, 17)
        val signed = OffsetDateTime.parse("2026-09-01T10:00:00Z")

        // 22:30 UTC on 27 September is 00:30 on 28 September in Prague (decision D10).
        val changedAtNight = OffsetDateTime.parse("2026-09-27T22:30:00Z")
        assertEquals(
            "Údaje o stavbě platné ke dni 17. 10. 2026 (nejsou součástí podpisu záznamu). Po podpisu tohoto záznamu byly změněny dne 28. 9. 2026.",
            PdfExportService.projectInfoNote(today, signed, changedAtNight),
        )
        // A draft has no signature to be outside of, and a change before the signature is not mentioned.
        assertEquals("Údaje o stavbě platné ke dni 17. 10. 2026.", PdfExportService.projectInfoNote(today, null, changedAtNight))
        assertEquals(
            "Údaje o stavbě platné ke dni 17. 10. 2026 (nejsou součástí podpisu záznamu).",
            PdfExportService.projectInfoNote(today, signed, OffsetDateTime.parse("2026-08-01T10:00:00Z")),
        )
    }

    @Test
    fun `typst is given times in Prague time with the zone, and the hash of the row of the signature`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val reportId = createReport(boss)
        signUnchecked(boss, reportId)
        val lockRowHash = dsl.fetchValue("""select row_hash from audit_log where action = 'report.lock' and entity_id = ?""", reportId.toString()) as String
        var data = ""
        PdfExportService.compiler = TypstCompiler { dir, _, pdfFile ->
            data = File(dir, "data.json").readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }

        PdfExportService.generateReportPdf(dsl, reportId)

        val json = Json.parseToJsonElement(data).jsonObject
        assertEquals(lockRowHash, json["auditRowHash"]!!.jsonPrimitive.content)
        assertEquals(reportId.toString(), json["entryId"]!!.jsonPrimitive.content)
        // The format the entry was signed in: the template explains a missing hash as "old" only for format 1.
        assertEquals(ReportSignature.CURRENT_FORMAT, json["signatureFormat"]!!.jsonPrimitive.int)
        assertTrue(Regex("""\d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}:\d{2} SE?L?Č \(UTC\+[12]\)""").matches(json["signedAt"]!!.jsonPrimitive.content), json["signedAt"].toString())
        assertEquals(0, json["photos"]!!.jsonArray.size, "no photos on this entry")
    }

    @Test
    fun `a draft is given no signature and no audit row`() = runBlocking<Unit> {
        val reportId = createReport()
        var data = ""
        PdfExportService.compiler = TypstCompiler { dir, _, pdfFile ->
            data = File(dir, "data.json").readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }

        PdfExportService.generateReportPdf(dsl, reportId)

        val json = Json.parseToJsonElement(data).jsonObject
        assertEquals(false, json["isSigned"]!!.jsonPrimitive.boolean)
        for (key in listOf("signedBy", "signedAt", "signatureHash", "auditRowHash")) assertEquals("", json[key]!!.jsonPrimitive.content, key)
        assertTrue(json["signatureFormat"] is kotlinx.serialization.json.JsonNull, "a draft is not signed in any format")
    }

    @Test
    fun `the PDF is returned with a stable file name`() = runBlocking<Unit> {
        val reportId = createReport()

        val document = PdfExportService.generateReportPdf(dsl, reportId)

        assertEquals("report_$reportId.pdf", document.fileName)
        assertArrayEquals(MINIMAL_PDF, document.bytes)
    }

    @Test
    fun `every export has its own directory that is removed afterwards`() = runBlocking<Unit> {
        val reportId = createReport()
        val directories = mutableListOf<File>()
        PdfExportService.compiler = TypstCompiler { dir, _, pdfFile ->
            directories += dir
            pdfFile.writeBytes(MINIMAL_PDF)
        }

        PdfExportService.generateReportPdf(dsl, reportId)
        PdfExportService.generateReportPdf(dsl, reportId)

        assertEquals(2, directories.size)
        assertNotEquals(directories[0], directories[1], "exports must not share a directory")
        directories.forEach { assertFalse(it.exists(), "$it must be deleted after the export") }
    }

    @Test
    fun `the directory is removed even when typst fails`() = runBlocking<Unit> {
        val reportId = createReport()
        var directory: File? = null
        PdfExportService.compiler = TypstCompiler { dir, _, _ ->
            directory = dir
            throw PdfExportException("boom")
        }

        assertThrows<PdfExportException> { PdfExportService.generateReportPdf(dsl, reportId) }

        assertFalse(directory!!.exists())
    }

    // --- what comes back must be a PDF ---------------------------------------------------------

    @Test
    fun `output that is not a PDF is an error, never served`() = runBlocking<Unit> {
        val reportId = createReport()
        PdfExportService.compiler = TypstCompiler { _, _, pdfFile -> pdfFile.writeText("<html>not a pdf</html>") }

        assertThrows<PdfExportException> { PdfExportService.generateReportPdf(dsl, reportId) }
    }

    @Test
    fun `no output file is an error`() = runBlocking<Unit> {
        val reportId = createReport()
        PdfExportService.compiler = TypstCompiler { _, _, _ -> /* typst "succeeded" but wrote nothing */ }

        assertThrows<PdfExportException> { PdfExportService.generateReportPdf(dsl, reportId) }
    }

    // --- the real process handling --------------------------------------------------------------

    private val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()

    @Test
    fun `a missing typst binary is reported as unavailable, not as an empty PDF`() = runBlocking<Unit> {
        val reportId = createReport()
        PdfExportService.compiler = ProcessTypstCompiler(command = { _, _, _ -> listOf("definitely-not-installed-typst-binary") })

        assertThrows<PdfUnavailableException> { PdfExportService.generateReportPdf(dsl, reportId) }
    }

    @Test
    fun `typst exiting with an error is an export error`() = runBlocking<Unit> {
        val reportId = createReport()
        PdfExportService.compiler = ProcessTypstCompiler(command = { _, _, _ -> listOf(java, "--no-such-option") })

        val error = assertThrows<PdfExportException> { PdfExportService.generateReportPdf(dsl, reportId) }

        assertTrue(error.message!!.contains("exit code"), error.message)
    }

    @Test
    fun `a typst that never finishes is killed after the timeout`() = runBlocking<Unit> {
        val reportId = createReport()
        PdfExportService.compiler = ProcessTypstCompiler(
            command = { dir, _, _ ->
                File(dir, "Sleep.java").writeText("public class Sleep { public static void main(String[] a) throws Exception { Thread.sleep(120000); } }")
                listOf(java, "Sleep.java")
            },
            timeout = Duration.ofSeconds(2),
        )

        val started = System.nanoTime()
        val error = assertThrows<PdfExportException> { PdfExportService.generateReportPdf(dsl, reportId) }
        val seconds = (System.nanoTime() - started) / 1_000_000_000.0

        assertTrue(error.message!!.contains("killed"), error.message)
        assertTrue(seconds < 30, "the export took $seconds s; the hanging process must be stopped by the timeout")
    }

    @Test
    fun `typst output volume cannot block the process`() = runBlocking<Unit> {
        // typst's output goes to a file. A tool that prints far more than a pipe buffer holds (64 KiB)
        // must still finish; it would hang forever if its output were read only after it exits.
        val reportId = createReport()
        PdfExportService.compiler = ProcessTypstCompiler(
            command = { dir, _, pdfFile ->
                File(dir, "Chatty.java").writeText(
                    "import java.nio.file.*; public class Chatty { public static void main(String[] a) throws Exception {" +
                        " for (int i = 0; i < 20000; i++) System.out.println(\"line \" + i + \" of noisy output, noisy output\");" +
                        " Files.write(Path.of(a[0]), \"%PDF-1.4\\n%%EOF\\n\".getBytes()); } }"
                )
                listOf(java, "Chatty.java", pdfFile.absolutePath)
            },
            timeout = Duration.ofSeconds(30),
        )

        val document = PdfExportService.generateReportPdf(dsl, reportId)

        assertTrue(String(document.bytes, Charsets.ISO_8859_1).startsWith("%PDF-"))
    }

    // --- load ------------------------------------------------------------------------------------

    @Test
    fun `at most two PDFs are rendered at the same time`() = runBlocking<Unit> {
        val reportId = createReport()
        val running = AtomicInteger()
        val peak = AtomicInteger()
        PdfExportService.compiler = TypstCompiler { _, _, pdfFile ->
            // incrementAndGet must run exactly once per render: inside updateAndGet the lambda may be re-run on contention.
            val now = running.incrementAndGet()
            peak.accumulateAndGet(now) { a, b -> maxOf(a, b) }
            Thread.sleep(300)
            pdfFile.writeBytes(MINIMAL_PDF)
            running.decrementAndGet()
        }

        coroutineScope {
            (1..6).map { async(Dispatchers.Default) { PdfExportService.generateReportPdf(dsl, reportId) } }.awaitAll()
        }

        assertTrue(peak.get() in 1..2, "peak concurrency was ${peak.get()}")
    }
}
