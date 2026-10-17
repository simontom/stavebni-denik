package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
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

    /** The text of every page, so a test can say on which page something is. */
    private fun pagesOf(pdf: ByteArray): List<String> = Loader.loadPDF(pdf).use { document ->
        val stripper = PDFTextStripper()
        (1..document.numberOfPages).map { number ->
            stripper.startPage = number
            stripper.endPage = number
            Normalizer.normalize(stripper.getText(document), Normalizer.Form.NFC)
        }
    }

    /** No white space at all: a long hash or a watermark may be broken over several lines of the extracted text. */
    private fun squeezed(text: String): String = text.filterNot { it.isWhitespace() }

    private suspend fun projectOf(boss: SessionUser, name: String = "Náležitosti", extra: (ProjectDto) -> ProjectDto = { it }): UUID =
        UUID.fromString(
            ProjectService.createProject(
                boss,
                extra(
                    ProjectDto(
                        id = "", name = name, address = "Address", cadastralArea = "Area",
                        parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
                    )
                )
            ).id
        )

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
        assertTrue(text.contains("pondělí 28. 9. 2026"), "a Czech date with the weekday: $text")
        assertFalse(text.contains("2026-09-28"), "no ISO date in a document for people: $text")
        assertTrue(text.contains("Betonáž stropu"), text)
        assertTrue(text.contains("Druhý řádek"), text)
    }

    @Test
    fun `the people on site and the fields of the vyhláška are printed, and hostile text stays text`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Náležitosti", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val saved = DailyReportService.saveReport(
            boss, UUID.fromString(project.id), "2026-09-28",
            DailyReportService.ReportInput(
                workDescription = "Betonáž",
                workersByTrade = """[{"trade":"Betonáři","count":3,"names":["Jan Novák","Petr Svoboda"]},{"trade":"Zedníci","count":2}]""",
                details = mapOf(
                    "materials" to "Beton C25/30\nVýztuž #panic(\"X\") a *tučně*",
                    "dustMeasures" to "Kropení povrchů",
                    "defects" to "Trhlina v omítce",
                ),
            ),
        )

        val text = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(saved.id)).bytes)

        assertTrue(text.contains("Pracovníci na stavbě"), text)
        assertTrue(text.contains("Betonáři"), text)
        assertTrue(text.contains("Jan Novák; Petr Svoboda"), text)
        assertTrue(Regex("""Celkem\s*5""").containsMatchIn(text), "the total of the workers: $text")
        assertTrue(text.contains("Dodávky a uskladnění materiálu a zařízení"), text)
        assertTrue(text.contains("Beton C25/30"), text)
        assertTrue(text.contains("#panic(\"X\")"), "markup in a field is printed as it was typed: $text")
        assertTrue(text.contains("Opatření proti prašnosti"), text)
        assertTrue(text.contains("Závady a jejich odstranění"), text)
        assertTrue(text.contains("Použité stroje a mechanizace"), "a field that was not filled in still has its heading: $text")
    }

    @Test
    fun `the identification of the project is printed, only what has a value, and hostile text stays text`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Bytový dům Zelená", address = "Karlova 15, Brno", cadastralArea = "Brno-střed", parcelNumbers = "450/1",
                builder = "Město Brno", contractor = "Stavitel a.s.", siteManagerId = boss.id.toString(),
                permitNumber = "SZ/2026/123", permitDate = "2026-03-01",
                subcontractors = "Elektro s.r.o.\nVodoinstalace #panic(\"X\") a *tučně*",
                supportingDocuments = "Smlouva o dílo č. SML-1",
            )
        )
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28", workDescription = "Betonáž")

        val text = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report.id)).bytes)

        assertTrue(text.contains("Katastrální území"), text)
        assertTrue(text.contains("Brno-střed"), text)
        assertTrue(text.contains("Stavebník"), text)
        assertTrue(text.contains("SZ/2026/123 ze dne 1. 3. 2026"), text)
        assertTrue(text.contains("Poddodavatelé"), text)
        assertTrue(text.contains("Vodoinstalace #panic(\"X\")"), "markup in a field is printed as it was typed: $text")
        assertTrue(text.contains("Podklady stavby"), text)
        assertFalse(text.contains("Projektant"), "a row without a value has no line: $text")
    }

    @Test
    fun `a draft says it has no number yet and a signed entry shows its number`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Číslo záznamu", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val report = UUID.fromString(DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28", workDescription = "Zápis").id)

        val draft = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)
        assertTrue(draft.contains("zatím bez čísla"), draft)

        // The number is given at signing (decision D11).
        DailyReportService.signReport(boss, report)
        val signed = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)
        assertTrue(signed.contains("č. 1"), signed)
        assertFalse(signed.contains("zatím bez čísla"), signed)
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

    // --- the entry as a document (backlog B8) -------------------------------------------------------------

    @Test
    fun `a draft is marked across the page, and says in words that it has no number`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val report = DailyReportService.createReport(boss, projectOf(boss), "2026-09-28", workDescription = "Zápis").id

        val text = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report)).bytes)

        assertTrue(squeezed(text).contains("KONCEPT–NEPODEPSÁNO"), "the watermark: $text")
        assertTrue(text.contains("Konec rozpracovaného denního záznamu"), text)
        assertTrue(text.contains("zatím bez čísla"), text)
        assertFalse(text.contains("Podepsal:"), "a draft has no signature block: $text")
    }

    @Test
    fun `a signed entry has no watermark and ends with its number`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectOf(boss), "2026-09-28", workDescription = "Zápis").id)
        DailyReportService.signReport(boss, report)

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertFalse(squeezed(text).contains("KONCEPT"), text)
        assertTrue(text.contains("Konec denního záznamu č. 1"), text)
        assertFalse(text.contains("Konec rozpracovaného"), text)
    }

    @Test
    fun `the control day and the construction object are printed, and so is the absence of both`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = projectOf(boss)
        val control = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Kontrola", isControlDay = true, constructionObj = "SO 02 Hala").id
        val plain = DailyReportService.createReport(boss, projectId, "2026-09-29", workDescription = "Běžný den").id

        val withBoth = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(control)).bytes)
        assertTrue(Regex("""Kontrolní den[^\n]*\bano\b""").containsMatchIn(withBoth), withBoth)
        assertTrue(Regex("""Stavební objekt[^\n]*SO 02 Hala""").containsMatchIn(withBoth), withBoth)

        val without = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(plain)).bytes)
        assertTrue(Regex("""Kontrolní den[^\n]*\bne\b""").containsMatchIn(without), without)
        assertTrue(Regex("""Stavební objekt[^\n]*bez záznamu""").containsMatchIn(without), without)
    }

    @Test
    fun `every heading is printed, with bez záznamu where nothing was entered`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val report = DailyReportService.createReport(boss, projectOf(boss), "2026-09-28").id

        val text = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report)).bytes)

        for (heading in listOf("Počasí", "Pracovníci na stavbě", "Popis prací") + EntryDetails.FIELDS.map { it.label }) {
            assertTrue(text.contains(heading), "heading '$heading' of an entry that says nothing: $text")
        }
        // The work description, the workers and the eight fields say nothing; so does the construction object.
        assertTrue(Regex("bez záznamu").findAll(text).count() >= 10, text)
    }

    @Test
    fun `the author of the entry is named`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "Ing. Autor Záznamu")
        val report = DailyReportService.createReport(boss, projectOf(boss), "2026-09-28", workDescription = "Zápis").id

        val text = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report)).bytes)

        assertTrue(Regex("""Autor záznamu[^\n]*Ing\. Autor Záznamu""").containsMatchIn(text), text)
    }

    @Test
    fun `every page has a footer with the project, the number, the date and the page of the total`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val long = (1..150).joinToString("\n") { "Řádek číslo $it popisu prací na stavbě." }
        val report = UUID.fromString(
            DailyReportService.createReport(boss, projectOf(boss, "Bytový dům Zelená"), "2026-09-28", workDescription = long).id
        )
        DailyReportService.signReport(boss, report)

        val pages = pagesOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertTrue(pages.size >= 3, "a long entry runs over several pages (${pages.size})")
        pages.forEachIndexed { index, page ->
            assertTrue(page.contains("Strana ${index + 1} z ${pages.size}"), "page ${index + 1}: $page")
            assertTrue(page.contains("Bytový dům Zelená"), "the project in the footer of page ${index + 1}")
            assertTrue(page.contains("Záznam č. 1"), "the number in the footer of page ${index + 1}")
            assertTrue(page.contains("28. 9. 2026"), "the date in the footer of page ${index + 1}")
        }
    }

    @Test
    fun `the footer of a draft says it has no number`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val report = DailyReportService.createReport(boss, projectOf(boss, "Koncept"), "2026-09-28", workDescription = "Zápis").id

        val pages = pagesOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report)).bytes)

        for ((index, page) in pages.withIndex()) {
            assertTrue(page.contains("Strana ${index + 1} z ${pages.size}"), page)
            assertTrue(Regex("""Koncept[^\n]*Záznam bez čísla[^\n]*28\. 9\. 2026""").containsMatchIn(page), page)
        }
    }

    @Test
    fun `part A, the identification with the subcontractors and the documents, comes before part B`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = projectOf(boss) {
            it.copy(subcontractors = "Elektro s.r.o.", supportingDocuments = "Smlouva o dílo č. SML-1", permitNumber = "SZ/1")
        }
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id

        val text = textOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report)).bytes)

        val partA = text.indexOf("Část A")
        val partB = text.indexOf("Část B")
        assertTrue(partA in 0 until partB, "both parts, A first: $text")
        for (inA in listOf("Katastrální území", "Povolení", "Poddodavatelé", "Elektro s.r.o.", "Podklady stavby", "Smlouva o dílo č. SML-1")) {
            val at = text.indexOf(inA)
            assertTrue(at in partA until partB, "'$inA' belongs to part A (at $at, A at $partA, B at $partB): $text")
        }
        for (inB in listOf("Počasí", "Popis prací", "Betonáž")) {
            assertTrue(text.indexOf(inB) > partB, "'$inB' belongs to part B: $text")
        }
    }

    @Test
    fun `the signature shows when it was made in Prague time with the zone, and the hash of its row in the audit chain`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "Ing. Podepsaný Stavbyvedoucí")
        val projectId = projectOf(boss)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
        DailyReportService.signReport(boss, report)
        // Something else is audited afterwards: the head of the chain is now another row than the one of the signature.
        projectOf(boss, "Jiná stavba")
        val lockRowHash = dsl.select(AUDIT_LOG.ROW_HASH).from(AUDIT_LOG)
            .where(AUDIT_LOG.ACTION.eq("report.lock").and(AUDIT_LOG.ENTITY_ID.eq(report.toString()))).fetchSingle().value1()!!
        val head = dsl.select(AUDIT_LOG.ROW_HASH).from(AUDIT_LOG).orderBy(AUDIT_LOG.ID.desc()).limit(1).fetchSingle().value1()!!
        assertNotEquals(lockRowHash, head, "the test needs a head that is not the row of the signature")
        val signedHash = dsl.fetchValue("""select "signatureHash" from daily_reports where id = ?""", report) as String

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertTrue(Regex("""Podepsal:[^\n]*Ing\. Podepsaný Stavbyvedoucí, ČKAIT 0012345""").containsMatchIn(text), text)
        assertTrue(Regex("""Čas podpisu:[^\n]*\d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}:\d{2} SE?L?Č \(UTC\+[12]\)""").containsMatchIn(text), "Prague time with the zone: $text")
        assertFalse(text.contains("(UTC)"), "no UTC times left: $text")
        assertTrue(squeezed(text).contains(signedHash), "the hash of the content: $text")
        assertTrue(squeezed(text).contains(lockRowHash), "the hash of the audit row of the signature: $text")
        assertFalse(squeezed(text).contains(head), "the head of the chain changes with every action and says how busy the company is: $text")
        assertTrue(text.contains(report.toString()), "the id of the entry, which the signature covers and which names the audit row: $text")
    }

    @Test
    fun `an entry signed without a row in the audit chain says so, and lists the photos with their hashes`() = runBlocking<Unit> {
        GoldenFixture.insertSignedEntry(dsl, signatureHash = "9".repeat(64))

        val text = textOf(PdfExportService.generateReportPdf(dsl, GoldenFixture.entryId).bytes)

        // (A long label may wrap in its cell, so the line break between the label and the value is allowed.)
        assertTrue(Regex("""audit[\s\S]{0,60}nenalezen""").containsMatchIn(text), "it says there is no row instead of failing: $text")
        assertTrue(squeezed(text).contains("9".repeat(64)), text)
        // 10:15:30.123 UTC on 28 September 2026 is 12:15:30 in Prague, on summer time.
        assertTrue(text.contains("28. 9. 2026 12:15:30 SELČ (UTC+2)"), text)
        // Two photos are on the entry, a third was removed and is not part of it.
        assertTrue(squeezed(text).contains("a".repeat(64)) && squeezed(text).contains("c".repeat(64)), text)
        assertFalse(squeezed(text).contains("e".repeat(64)), "a removed photo is not listed: $text")
        assertTrue(Regex("""Kontrolní den[^\n]*\bano\b""").containsMatchIn(text), text)
        assertTrue(Regex("""Stavební objekt[^\n]*SO 01""").containsMatchIn(text), text)
        assertTrue(Regex("""Celkem\s*5""").containsMatchIn(text), text)
    }

    @Test
    fun `hostile text in the author, the signer, the construction object and the photos stays text`() = runBlocking<Unit> {
        val hostile = "#panic(\"X\") *tučně* \$ x \$"
        val boss = createTestUser(role = Role.BOSS, displayName = hostile)
        val projectId = projectOf(boss, "#read(\"/etc/passwd\")")
        val report = UUID.fromString(
            DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž", constructionObj = "#panic(\"Y\")").id
        )
        dsl.execute(
            """insert into photos (id, "reportId", "pathOriginal", "pathThumb", width, height, bytes, "uploadedById", "sha256")
               values (gen_random_uuid(), ?, 'photos/x.jpg', 'photos/x-thumb.jpg', 800, 600, 1000, ?, ?)""",
            report, boss.id, "a".repeat(64),
        )
        DailyReportService.signReport(boss, report)

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertTrue(Regex("""Autor záznamu: [^\n]*#panic\("X"\) \*tučně\*""").containsMatchIn(text), text)
        assertTrue(Regex("""Podepsal: [^\n]*#panic\("X"\) \*tučně\*""").containsMatchIn(text), text)
        assertTrue(text.contains("#panic(\"Y\")"), text)
        assertTrue(text.contains("#read(\"/etc/passwd\")"), "the project name, in the footer and the tables: $text")
        assertFalse(text.contains("root:x"), "nothing was read from the machine")
    }

    // --- the layout, with data made by hand (no database) -----------------------------------------------------

    private fun dataOf(workDescription: String, isSigned: Boolean = true, projectName: String = "Bytový dům Zelená") = ReportPdfData(
        projectName = projectName, address = "Karlova 15", date = "28. 9. 2026", weekday = "pondělí",
        sequenceNumber = if (isSigned) 7 else null, isSigned = isSigned,
        isLateEntry = false, lateEntryReason = "", weather = "Neuvedeno", workDescription = workDescription,
        entryId = "00000000-0000-4000-8000-000000000007",
        signedBy = if (isSigned) "Ing. Jan Stavbyvedoucí, ČKAIT 0012345" else "", signedAt = if (isSigned) "28. 9. 2026 14:32:07 SELČ (UTC+2)" else "",
        signatureHash = if (isSigned) "5".repeat(64) else "", auditRowHash = if (isSigned) "7".repeat(64) else "",
    )

    private fun lines(count: Int) = (1..count).joinToString("\n") { "Řádek číslo $it popisu prací na stavbě." }

    private fun render(data: ReportPdfData): ByteArray = PdfExportService.render(data, UUID.randomUUID()).bytes

    @Test
    fun `the signature and the end of the entry are never split between two pages, wherever the page breaks`() {
        // Entries of every length across two pages: wherever the page break falls, the heading "Podpis", its hashes and the line
        // that ends the entry are on one page (a block that may not break moves to the next page as a whole). Without that
        // rule entries of 20 to 22 and of 65 to 74 lines are split (typst 0.15.1); every second length is tried so that a
        // change of the layout cannot move the zone out of the range unnoticed.
        var splitAt = emptyList<Int>()
        for (count in 20..130 step 2) {
            val pages = pagesOf(render(dataOf(lines(count))))
            val heading = pages.indexOfFirst { Regex("(?m)^Podpis$").containsMatchIn(it) }
            val hash = pages.indexOfFirst { squeezed(it).contains("7".repeat(64)) }
            val end = pages.indexOfFirst { it.contains("Konec denního záznamu č. 7") }
            if (heading < 0 || heading != hash || heading != end) splitAt += count
        }
        assertEquals(emptyList<Int>(), splitAt, "entries of these numbers of lines have a signature that is split between two pages")
    }

    @Test
    fun `every page of a draft carries the watermark`() {
        val pages = pagesOf(render(dataOf(lines(150), isSigned = false)))

        assertTrue(pages.size >= 3, "a long draft runs over several pages")
        pages.forEachIndexed { index, page -> assertTrue(squeezed(page).contains("KONCEPT–NEPODEPSÁNO"), "page ${index + 1}: $page") }
    }

    @Test
    fun `the total of a long table of workers is printed once, under its last row`() {
        val workers = (1..60).map { WorkerPdf("Profese $it", it, "") }

        val pages = pagesOf(render(dataOf("Zápis").copy(workers = workers)))
        val text = pages.joinToString("\n")

        assertTrue(pages.size >= 3, "sixty trades run over several pages")
        assertEquals(1, Regex("Celkem").findAll(text).count(), "the total is not repeated on every page: $text")
        assertTrue(Regex("""Celkem\s*1830""").containsMatchIn(text), text)
        assertTrue(pages.count { it.contains("Profese") && it.contains("Počet") } >= 2, "the header of the table is repeated on the next page")
    }

    @Test
    fun `a very long project name does not break the footer`() {
        val name = (1..60).joinToString("\n") { "Stavba číslo $it s velmi dlouhým názvem" }

        val pages = pagesOf(render(dataOf("Zápis", projectName = name)))

        pages.forEachIndexed { index, page ->
            assertTrue(page.contains("Strana ${index + 1} z ${pages.size}"), page)
            assertTrue(Regex("""Stavba číslo 1 s velmi[^\n]*…[^\n]*Záznam č\. 7[^\n]*28\. 9\. 2026""").containsMatchIn(page), "the project name is cut to one line in the footer: $page")
        }
    }

    @Test
    fun `a signed entry without a content hash says so`() = runBlocking<Unit> {
        GoldenFixture.insertSignedEntry(dsl, signatureHash = null)

        val text = textOf(PdfExportService.generateReportPdf(dsl, GoldenFixture.entryId).bytes)

        assertTrue(Regex("""Otisk obsahu[^\n]*neuložen""").containsMatchIn(text), text)
    }
}
