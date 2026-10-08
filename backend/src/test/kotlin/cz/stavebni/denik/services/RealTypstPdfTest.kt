package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import kotlinx.coroutines.runBlocking
import org.apache.pdfbox.Loader
import org.apache.pdfbox.text.PDFTextStripper
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.text.Normalizer
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Runs the real typst tool, so these tests prove that the fixed template compiles and that hostile
 * report text is rendered as plain text. They are skipped when typst is not installed; CI installs it
 * and sets REQUIRE_TYPST=1, which turns "not installed" into a failure instead of a skip.
 */
class RealTypstPdfTest : BaseIntegrationTest() {

    @BeforeEach
    fun useRealTypst() {
        val installed = try {
            val process = ProcessBuilder("typst", "--version").redirectErrorStream(true).start()
            process.waitFor(20, TimeUnit.SECONDS) && process.exitValue() == 0
        } catch (e: Exception) {
            false
        }
        if (!installed) {
            if (System.getenv("REQUIRE_TYPST") == "1") fail<Unit>("typst is required (REQUIRE_TYPST=1) but is not installed")
            assumeTrue(false, "typst is not installed")
        }
        PdfExportService.compiler = ProcessTypstCompiler()
    }

    private fun textOf(pdf: ByteArray): String =
        Loader.loadPDF(pdf).use { Normalizer.normalize(PDFTextStripper().getText(it), Normalizer.Form.NFC) }

    private suspend fun exportText(projectName: String, description: String): String {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = projectName, address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28", workDescription = description)
        return textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report.id)).bytes)
    }

    @Test
    fun `the report is rendered as a real PDF with its content`() = runBlocking {
        val text = exportText("Bytový dům Zelená", "Betonáž stropu\nDruhý řádek")

        assertTrue(text.contains("Denní záznam stavby"), text)
        assertTrue(text.contains("Bytový dům Zelená"), text)
        assertTrue(text.contains("2026-09-28"), text)
        assertTrue(text.contains("Betonáž stropu"), text)
        assertTrue(text.contains("Druhý řádek"), text)
    }

    @Test
    fun `a late entry says so in the PDF, with its reason (hostile text stays text)`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Pozdní zápis", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28", workDescription = "Zápis")
        dsl.update(cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS)
            .set(cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS.ISLATEENTRY, true)
            .set(cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS.LATEENTRYREASON, "Deník byl na jiné stavbě #panic(\"X\")")
            .where(cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS.ID.eq(UUID.fromString(report.id)))
            .execute()

        val text = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report.id)).bytes)

        assertTrue(text.contains("Pozdní zápis:"), text)
        assertTrue(text.contains("Deník byl na jiné stavbě #panic(\"X\")"), text)
    }

    @Test
    fun `the weather is written as readable text in the PDF`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Počasí", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val report = DailyReportService.createReport(
            boss, UUID.fromString(project.id), "2026-09-28",
            workDescription = "Zápis", weather = cz.stavebni.denik.domain.WeatherData(8.5, 15.0, "zataženo, mlha")
        )

        val text = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report.id)).bytes)

        assertTrue(text.contains("zataženo, mlha, 8,5 až 15 °C"), text)
        assertFalse(text.contains("tempMin"), "no raw JSON in the PDF: $text")
    }

    @Test
    fun `an entry that is on time has no late-entry line`() = runBlocking {
        val text = exportText("Včas", "Normální zápis")

        assertFalse(text.contains("Pozdní zápis:"), text)
    }

    @Test
    fun `typst code and markup in report text is shown as text and never executed`() = runBlocking {
        val text = exportText(
            projectName = "#panic(\"INJECTED\") *bold* _it_",
            description = "#read(\"/etc/passwd\")\n#include \"main.typ\"\n#for i in range(100000000) [x]\n\$ x \$ <label> @ref",
        )

        // Every payload appears literally...
        assertTrue(text.contains("#panic(\"INJECTED\")"), text)
        assertTrue(text.contains("#read(\"/etc/passwd\")"), text)
        assertTrue(text.contains("#include \"main.typ\""), text)
        assertTrue(text.contains("*bold*"), text)
        // ...and nothing was read from the machine.
        assertFalse(text.contains("root:x"), "the file read must not have run")
    }

    @Test
    fun `backslashes quotes and line endings of the text come out unchanged`() = runBlocking {
        val backslash = '\\'
        val text = exportText(
            projectName = "C:${backslash}Stavba${backslash}Hala",
            description = "Řádek 1\r\nŘádek 2\tmezera\r\n\r\nŽluťoučký kůň \"uvozovky\"",
        )

        assertTrue(text.contains("C:${backslash}Stavba${backslash}Hala"), text)
        assertTrue(text.contains("Řádek 1"), text)
        assertTrue(text.contains("Řádek 2"), text)
        assertTrue(text.contains("Žluťoučký kůň \"uvozovky\""), text)
    }

    @Test
    fun `a very long description still renders within the time limit`() = runBlocking {
        val long = (1..2000).joinToString("\n") { "Řádek číslo $it popisu prací na stavbě." }

        val text = exportText("Dlouhý záznam", long)

        assertTrue(text.contains("Řádek číslo 1 popisu"), text.take(200))
        assertTrue(text.contains("Řádek číslo 2000 popisu"))
    }
}
