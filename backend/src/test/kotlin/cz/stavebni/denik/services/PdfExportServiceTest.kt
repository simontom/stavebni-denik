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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File
import java.nio.file.Path
import java.time.Duration
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
        assertEquals("2026-09-28", json["date"]!!.jsonPrimitive.content)
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
