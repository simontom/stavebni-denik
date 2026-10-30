package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/**
 * Runs the real typst tool (see [RealTypstTestBase]), so these tests prove that the fixed template compiles and that hostile
 * report text is rendered as plain text.
 */
class RealTypstPdfTest : RealTypstTestBase() {

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

        val text = flatTextOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(saved.id)).bytes)

        assertTrue(text.contains("Pracovníci na stavbě"), text)
        assertTrue(text.contains("Betonáři"), text)
        assertTrue(text.contains("Jan Novák; Petr Svoboda"), text)
        assertTrue(Regex("""Celkem\s*5""").containsMatchIn(text), "the total of the workers: $text")
        assertTrue(text.contains("Dodávky materiálu, výrobků, strojů a zařízení, jejich uskladnění a zabudování"), text)
        assertTrue(text.contains("Beton C25/30"), text)
        assertTrue(text.contains("#panic(\"X\")"), "markup in a field is printed as it was typed: $text")
        assertTrue(text.contains("Opatření proti prašnosti"), text)
        assertTrue(text.contains("Závady a jejich odstranění"), text)
        assertTrue(text.contains("Mechanizace"), "a field that was not filled in still has its heading: $text")
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

        val text = flatTextOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report.id)).bytes)

        assertTrue(text.contains("Katastrální území"), text)
        assertTrue(text.contains("Brno-střed"), text)
        assertTrue(text.contains("Stavebník (název a sídlo, IČO)"), text)
        assertTrue(text.contains("SZ/2026/123 ze dne 1. 3. 2026"), text)
        assertTrue(text.contains("Poddodavatelé (název, sídlo, IČO)"), text)
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
        signUnchecked(boss, report)
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
                id = "", name = "Pozdní záznam", address = "Address", cadastralArea = "Area",
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

        assertTrue(text.contains("Pozdní záznam:"), text)
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

        assertFalse(text.contains("Pozdní záznam:"), text)
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
    fun `a very long description still renders within the time limit, whole up to its budget`() = runBlocking {
        val long = (1..900).joinToString("\n") { "Řádek číslo $it popisu prací na stavbě." }

        val text = exportText("Dlouhý záznam", long)

        assertTrue(text.contains("Řádek číslo 1 popisu"), text.take(200))
        assertTrue(text.contains("Řádek číslo 900 popisu"))
        assertFalse(text.contains("se do tohoto výtisku nevešlo"), "nothing was left out")
    }

    @Test
    fun `a description of more lines than the budget allows is cut, and the document says how many lines were left out`() = runBlocking {
        val long = (1..2500).joinToString("\n") { "Řádek číslo $it popisu prací na stavbě." }

        val text = exportText("Dlouhý záznam", long)

        assertTrue(text.contains("Řádek číslo 1 popisu"), text.take(200))
        assertTrue(text.contains("Řádek číslo ${PdfExportService.ENTRY_FIELD_CAP_LINES} popisu"), "the lines up to the cap are printed")
        assertFalse(text.contains("Řádek číslo ${PdfExportService.ENTRY_FIELD_CAP_LINES + 1} popisu"), "the next one is not")
        assertTrue(text.replace(Regex("\\s+"), " ").contains("… a dalších ${2500 - PdfExportService.ENTRY_FIELD_CAP_LINES} řádků se do tohoto výtisku nevešlo; úplné znění je v aplikaci."), text.takeLast(600))
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
        signUnchecked(boss, report)

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

        val text = flatTextOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report)).bytes)

        for (heading in listOf("Počasí a stav staveniště", "Pracovníci na stavbě", "Popis prací") + EntryDetails.FIELDS.map { it.label }) {
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
        signUnchecked(boss, report)

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

        val text = flatTextOf(PdfExportService.generateReportPdf(dsl, UUID.fromString(report)).bytes)

        val partA = text.indexOf("Část A")
        val partB = text.indexOf("Část B")
        assertTrue(partA in 0 until partB, "both parts, A first: $text")
        for (inA in listOf("Katastrální území", "Číslo jednací povolení", "Poddodavatelé (název, sídlo, IČO)", "Elektro s.r.o.", "Podklady stavby", "Smlouva o dílo č. SML-1")) {
            val at = text.indexOf(inA)
            assertTrue(at in partA until partB, "'$inA' belongs to part A (at $at, A at $partA, B at $partB): $text")
        }
        for (inB in listOf("Počasí a stav staveniště", "Popis prací", "Betonáž")) {
            assertTrue(text.indexOf(inB) > partB, "'$inB' belongs to part B: $text")
        }
    }

    @Test
    fun `the signature shows when it was made in Prague time with the zone, and the hash of its row in the audit chain`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "Ing. Podepsaný Stavbyvedoucí")
        val projectId = projectOf(boss)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(boss, report)
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
            """insert into photos (id, "reportId", "pathOriginal", "pathThumb", width, height, bytes, "uploadedById", "uploadedByName", "sha256")
               values (gen_random_uuid(), ?, 'photos/x.jpg', 'photos/x-thumb.jpg', 800, 600, 1000, ?, ?, ?)""",
            report, boss.id, hostile, "a".repeat(64),
        )
        signUnchecked(boss, report)

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertTrue(Regex("""Autor záznamu: [^\n]*#panic\("X"\) \*tučně\*""").containsMatchIn(text), text)
        assertTrue(Regex("""Podepsal: [^\n]*#panic\("X"\) \*tučně\*""").containsMatchIn(text), text)
        assertTrue(text.contains("#panic(\"Y\")"), text)
        assertTrue(text.contains("#read(\"/etc/passwd\")"), "the project name, in the footer and the tables: $text")
        assertFalse(text.contains("root:x"), "nothing was read from the machine")
    }

    // --- signature format 3: part A as it stood, and the signer as stored ---------------------------------------

    private suspend fun projectWithPersons(boss: SessionUser): UUID {
        val projectId = projectOf(boss, "Bytový dům Zelená") {
            it.copy(
                contractor = "Zhotovitel s.r.o.", authorSupervisionName = "Ing. arch. Petr Dozor", authorSupervisionAuthorization = "ČKA 00 123",
                subcontractors = "Elektro s.r.o.", supportingDocuments = "Smlouva o dílo č. SML-1",
            )
        }
        val supervisor = createTestUser(nickname = "dozor", displayName = "Ing. Karel Dozor", role = Role.INSPECTOR, ckaitNumber = "0077777")
        val deputy = createTestUser(nickname = "deputy", displayName = "Marie Zástupce", role = Role.BOSS, ckaitNumber = "0099999")
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(supervisor.id.toString(), "INSPECTOR", "Technický dozor stavebníka, celé dílo"))
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(deputy.id.toString(), "BOSS", "Zástupce stavbyvedoucího, objekty SO 02 a SO 03"))
        AuthorizedPersonService.create(boss, projectId, CreateAuthorizedPersonRequest("Eva Koordinátorka", "BOZP s.r.o.", "Koordinátor BOZP na staveništi"))
        return projectId
    }

    @Test
    fun `a signed entry prints part A as it stood on the day of signing, with its persons, their scope and the author's supervision`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "Ing. Jan Stavbyvedoucí")
        val projectId = projectWithPersons(boss)
        // The entry is written by a worker and signed by the manager: it is the signer who is frozen, not the author (backlog B9).
        val worker = createTestUser(nickname = "worker", displayName = "Pavel Dělník", role = Role.WORKER)
        addMember(projectId, worker, Role.WORKER)
        val report = UUID.fromString(DailyReportService.createReport(worker, projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(boss, report)
        val snapshot = dsl.fetchValue("""select "partASnapshot" from daily_reports where id = ?""", report) as String

        // Afterwards the project is changed, a person is revoked and the signer is renamed.
        val current = ProjectService.getProject(dsl, boss, projectId)
        ProjectService.updateProject(boss, projectId, current.copy(name = "Přejmenovaná stavba", contractor = "Jiný zhotovitel", authorSupervisionName = "Někdo jiný"))
        dsl.execute("""update authorized_persons set "revokedAt" = now()""")
        dsl.execute("""update users set "displayName" = 'Změněné Jméno' where id = ?""", boss.id)

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        for (printed in listOf(
            "Bytový dům Zelená", "Zhotovitel s.r.o.", "Autorský dozor", "Ing. arch. Petr Dozor, autorizace ČKA 00 123",
            "Osoby zajišťující odborné vedení provádění stavby", "Číslo ČKAIT", "Rozsah oprávnění a odpovědnosti",
            "Marie Zástupce", "0099999", "Zástupce stavbyvedoucího, objekty SO 02 a SO 03", "Ing. Jan Stavbyvedoucí (stavbyvedoucí)",
            "Dozor (technický dozor stavebníka, autorský dozor)", "Ing. Karel Dozor", "Technický dozor stavebníka, celé dílo",
            "Pověřené osoby", "Eva Koordinátorka", "BOZP s.r.o.", "Koordinátor BOZP na staveništi",
            "Údaje o stavbě platné ke dni podpisu", "jsou součástí podpisu záznamu", "Otisk údajů o stavbě (SHA-256)",
        )) {
            assertTrue(squeezed(text).contains(squeezed(printed)), "'$printed' is printed: $text")
        }
        assertTrue(squeezed(text).contains(PartASnapshot.sha256(snapshot)), "the hash of the stored part A is in the signature block: $text")
        for (notPrinted in listOf("Přejmenovaná stavba", "Jiný zhotovitel", "Někdo jiný", "Změněné Jméno")) {
            assertFalse(text.contains(notPrinted), "'$notPrinted' came after the signature and is not part of it: $text")
        }
        // Part A comes before part B, as it did, with the persons in it.
        val partA = text.indexOf("Část A")
        val partB = text.indexOf("Část B")
        for (inA in listOf("Osoby zajišťující odborné vedení", "Pověřené osoby", "Dozor (technický")) {
            assertTrue(text.indexOf(inA) in partA until partB, "'$inA' belongs to part A: $text")
        }
        // The signer is the stored one, and so is the site manager of part A.
        assertTrue(Regex("""Podepsal:[^\n]*Ing\. Jan Stavbyvedoucí, ČKAIT 0012345""").containsMatchIn(text), text)
        assertTrue(Regex("""Autor záznamu:[^\n]*Pavel Dělník""").containsMatchIn(text), text)
    }

    @Test
    fun `text without a space in the tables of persons breaks inside its cell, is all printed, and does not run over the edge of the page`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "Ing. Jan Stavbyvedoucí")
        val projectId = projectOf(boss)
        // Each long text is made of a letter that is nowhere else in the document, so that the letters of the page can be counted: a
        // table may break a word over several lines, and the text of a row is then extracted line by line, with its other cells.
        val other = createTestUser(nickname = "dozor", displayName = "\u010e".repeat(200), role = Role.INSPECTOR, ckaitNumber = "W".repeat(50))
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(other.id.toString(), "INSPECTOR", "\u011a".repeat(ProjectMemberService.MAX_SCOPE_CHARS)))
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(boss.id.toString(), "BOSS", "Ý".repeat(ProjectMemberService.MAX_SCOPE_CHARS)))
        AuthorizedPersonService.create(
            boss, projectId,
            CreateAuthorizedPersonRequest(
                "\u017d".repeat(AuthorizedPersonService.MAX_NAME_CHARS), "\u016e".repeat(AuthorizedPersonService.MAX_COMPANY_CHARS),
                "\u0164".repeat(AuthorizedPersonService.MAX_AUTHORIZATION_CHARS),
            ),
        )
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(boss, report)

        val pdf = PdfExportService.generateReportPdf(dsl, report).bytes
        val text = squeezed(textOf(pdf))

        for ((letter, count) in listOf('\u010e' to 200, 'W' to 50, '\u011a' to 500, 'Ý' to 500, '\u017d' to 200, '\u016e' to 200, '\u0164' to 500)) {
            assertEquals(count, text.count { it == letter }, "every character of the text made of '$letter' is printed, once")
        }
        // Everything stays inside the margins of the page (2 cm = 57 points from the edge of 595), the footer included.
        val (furthest, where) = rightmostPoint(pdf)
        assertTrue(furthest <= 595.28f - 56.69f + 1f, "the text reaches $furthest, past the margin: $where")
        val pages = pagesOf(pdf)
        assertTrue(pages.size <= 4, "the pages are ${pages.size}")
        assertTrue(pages.any { Regex("(?m)^Podpis$").containsMatchIn(it) && it.contains("Konec denního záznamu č. 1") }, "the signature and the end of the entry are on one page")
    }

    @Test
    fun `a draft prints part A as it stands now, with the persons and the note it always had`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "Ing. Jan Stavbyvedoucí")
        val projectId = projectWithPersons(boss)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertTrue(text.contains("Údaje o stavbě platné ke dni "), text)
        assertFalse(text.contains("podpisu záznamu"), "a draft has no signature to be part of or outside of: $text")
        assertTrue(text.contains("Technický dozor stavebníka, celé dílo"), text)
        assertTrue(text.contains("Koordinátor BOZP na staveništi"), text)
        assertFalse(text.contains("Otisk údajů o stavbě"), "a draft has no signature block: $text")
    }

    @Test
    fun `the persons of part A that hold hostile text are printed as text`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "#panic(\"X\") *Jan*")
        val projectId = projectOf(boss)
        val other = createTestUser(nickname = "dozor", displayName = "#read(\"/etc/passwd\")", role = Role.INSPECTOR)
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(other.id.toString(), "INSPECTOR", "= nadpis \$ x \$ #include \"main.typ\""))
        AuthorizedPersonService.create(boss, projectId, CreateAuthorizedPersonRequest("#panic(\"P\")", "*firma*", "#panic(\"F\")"))
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(boss, report)

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        for (printed in listOf("#panic(\"X\") *Jan*", "#read(\"/etc/passwd\")", "= nadpis \$ x \$ #include \"main.typ\"", "#panic(\"P\")", "*firma*", "#panic(\"F\")")) {
            assertTrue(squeezed(text).contains(squeezed(printed)), "'$printed' is printed as it was typed: $text")
        }
        assertFalse(text.contains("root:x"), "nothing was read from the machine")
    }

    @Test
    fun `a format 3 entry that lost its part A says so, and prints no present data as if it were the signed one`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = projectWithPersons(boss)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(boss, report)
        dsl.withoutConstraint("daily_reports_signature_format_3_check", table = "daily_reports") {
            dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
            try {
                dsl.execute("""update daily_reports set "partASnapshot" = null where id = ?""", report)
            } finally {
                dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
            }
        }

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertTrue(Regex("""nejsou[\s\S]{0,20}uloženy[\s\S]{0,30}nelze ověřit""").containsMatchIn(text), text)
        assertTrue(Regex("""Otisk údajů o stavbě[\s\S]{0,120}nelze ověřit""").containsMatchIn(text), text)
        assertFalse(text.contains("Ing. Karel Dozor"), "today's persons are not printed in its place: $text")
        assertFalse(text.contains("Zhotovitel s.r.o."), text)
    }

    @Test
    fun `a project with the most persons it may have is printed within the time limit`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = projectOf(boss)
        val scope = "Rozsah oprávnění a odpovědnosti osoby číslo %d. ".repeat(10).take(500)
        for (n in 1 until PartASnapshot.MAX_PERSONS) {
            val id = UUID.randomUUID()
            dsl.execute(
                """insert into users (id, nickname, "displayName", "passwordHash", role, "isActive", "mustChangePwd") values (?, ?, ?, 'x', 'INSPECTOR', true, false)""",
                id, "bulk$n", "Člen číslo $n",
            )
            dsl.execute("""insert into project_members ("projectId", "userId", role, scope) values (?, ?, 'INSPECTOR', ?)""", projectId, id, scope.replace("%d", n.toString()))
        }
        repeat(PartASnapshot.MAX_PERSONS) { n ->
            dsl.execute("""insert into authorized_persons ("projectId", name, company, "authorization") values (?, ?, 'Firma', ?)""", projectId, "Osoba $n", scope)
        }
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(boss, report)

        val pages = pagesOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertTrue(pages.size > 3, "two hundred persons take several pages: ${pages.size}")
        val last = pages.indexOfFirst { it.contains("Konec denního záznamu č. 1") }
        assertTrue(last >= 0 && Regex("(?m)^Podpis$").containsMatchIn(pages[last]), "the signature and the end of the entry are on one page")
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
    fun `the signature block of format 3, with its row for part A, is never split between two pages either`() {
        var splitAt = emptyList<Int>()
        for (count in 20..130 step 2) {
            val pages = pagesOf(render(dataOf(lines(count)).copy(signatureFormat = 3, partASha256 = "8".repeat(64))))
            val heading = pages.indexOfFirst { Regex("(?m)^Podpis$").containsMatchIn(it) }
            val hash = pages.indexOfFirst { squeezed(it).contains("8".repeat(64)) }
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
    fun `an entry of the first signature format without a hash or an audit row is explained as an old entry`() = runBlocking<Unit> {
        // Format 1 is what was signed before hashes (and, in test data, the audit trail) existed: nothing is missing that was ever there.
        GoldenFixture.insertSignedEntry(dsl, signatureHash = null, signatureFormat = 1)

        val text = textOf(PdfExportService.generateReportPdf(dsl, GoldenFixture.entryId).bytes)

        assertTrue(Regex("""Otisk obsahu[\s\S]{0,60}neuložen[\s\S]{0,40}před zavedením otisků""").containsMatchIn(text), text)
        assertTrue(Regex("""audit[\s\S]{0,60}nenalezen[\s\S]{0,40}před zavedením auditního deníku""").containsMatchIn(text), text)
        assertFalse(text.contains("nelze ověřit"), text)
    }

    @Test
    fun `an entry of the second format without a content hash is a failure, not an old entry`() = runBlocking<Unit> {
        // From format 2 on a missing hash is a failure (ReportSignature.check): the PDF must not explain it away as a legacy entry.
        GoldenFixture.insertSignedEntry(dsl, signatureHash = null, signatureFormat = 2)

        val text = textOf(PdfExportService.generateReportPdf(dsl, GoldenFixture.entryId).bytes)

        assertTrue(Regex("""Otisk obsahu[\s\S]{0,60}chybí[\s\S]{0,20}nelze ověřit""").containsMatchIn(text), text)
        assertFalse(text.contains("před zavedením otisků"), "a damaged entry is not explained as an old one: $text")
    }

    @Test
    fun `an entry of the second format without a row in the audit chain is a failure, not an old entry`() = runBlocking<Unit> {
        GoldenFixture.insertSignedEntry(dsl, signatureHash = "9".repeat(64), signatureFormat = 2)

        val text = textOf(PdfExportService.generateReportPdf(dsl, GoldenFixture.entryId).bytes)

        assertTrue(Regex("""audit[\s\S]{0,80}chybí[\s\S]{0,20}nelze ověřit""").containsMatchIn(text), text)
        assertFalse(text.contains("před zavedením auditního deníku"), "an entry signed in format 2 is not older than the audit trail: $text")
        assertTrue(squeezed(text).contains("9".repeat(64)), "the hash that is there is still printed: $text")
    }

    @Test
    fun `a signer with an enormous name does not push the end of the entry off the page`() = runBlocking<Unit> {
        // The signature check shows the full values; the PDF cuts them, because the signature block may not be split.
        for ((label, name, ckait) in listOf(
            Triple("words", "Jan Novák ".repeat(400), "1234567890 ".repeat(400)),
            Triple("one long word", "A".repeat(4000), "9".repeat(4000)),
        )) {
            val boss = createTestUser(role = Role.BOSS, displayName = name, ckaitNumber = ckait)
            val projectId = projectOf(boss, "Dlouhé jméno $label")
            val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
            signUnchecked(boss, report)
            val signedHash = dsl.fetchValue("""select "signatureHash" from daily_reports where id = ?""", report) as String

            val pages = pagesOf(PdfExportService.generateReportPdf(dsl, report).bytes)

            val heading = pages.indexOfFirst { Regex("(?m)^Podpis$").containsMatchIn(it) }
            val hash = pages.indexOfFirst { squeezed(it).contains(signedHash) }
            val end = pages.indexOfFirst { it.contains("Konec denního záznamu č. 1") }
            assertTrue(heading >= 0 && heading == hash && heading == end, "$label: heading on page $heading, hash on $hash, the end on $end")
            assertTrue(pages[heading].contains("Podepsal:"), label)
        }
    }

    @Test
    fun `a draft with an entry of another party is not described as having a signature`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = projectOf(boss)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
        // Nothing stops an entry of another party on a draft (RemarkService has no lock check).
        RemarkService.create(boss, report, CreateRemarkRequest(text = "Stavební úřad si vyžádal doklady.", externalAuthor = "Stavební úřad"))

        val text = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)

        assertTrue(text.contains("Stavební úřad si vyžádal doklady."), text)
        assertTrue(text.contains("záznam ještě není podepsán"), "a neutral heading for a draft: $text")
        assertFalse(text.contains("Připojeno po podpisu"), "a draft has no signature to come after: $text")
        assertFalse(text.contains("nejsou součástí podpisu záznamu"), text)
        // A signed entry keeps its wording.
        signUnchecked(boss, report)
        val signed = textOf(PdfExportService.generateReportPdf(dsl, report).bytes)
        assertTrue(signed.contains("Připojeno po podpisu záznamu"), signed)
        assertTrue(signed.contains("nejsou součástí podpisu záznamu"), signed)
    }
}
