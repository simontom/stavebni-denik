package cz.stavebni.denik.services

import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.UUID
import javax.imageio.ImageIO

/**
 * The handover protocols (příloha 12 B.2 a)) and the names of who wrote each record, in the PDF that the real typst makes (backlog
 * B9): what is printed and where, the long-word wrapping, the signature block that is never split, a project with the most protocols
 * with the most meters. What the template is given is checked in [PdfHandoversDataTest] and [PdfFrozenAuthorsDataTest].
 */
class RealTypstHandoversPdfTest : RealTypstTestBase() {

    private class Site(val projectId: UUID, val boss: SessionUser, val worker: SessionUser, val investor: SessionUser, val inspector: SessionUser)

    private suspend fun site(): Site {
        val boss = createTestUser(nickname = "boss", displayName = "Ing. Jan Stavbyvedoucí", role = Role.BOSS, ckaitNumber = "0012345")
        val worker = createTestUser(nickname = "worker", displayName = "Pavel Dělník", role = Role.WORKER)
        val investor = createTestUser(nickname = "investor", displayName = "Marie Stavebníková", role = Role.INVESTOR)
        val inspector = createTestUser(nickname = "dozor", displayName = "Ing. Karel Dozor", role = Role.INSPECTOR, ckaitNumber = "0077777")
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Bytový dům Zelená", address = "Karlova 15", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        for (member in listOf(worker, investor, inspector)) addMember(projectId, member)
        return Site(projectId, boss, worker, investor, inspector)
    }

    private suspend fun entry(s: Site, day: String = "2026-09-28"): UUID =
        UUID.fromString(DailyReportService.createReport(s.boss, s.projectId, day, workDescription = "Betonáž").id)

    private suspend fun pdfOf(reportId: UUID): ByteArray = PdfExportService.generateReportPdf(dsl, reportId).bytes

    private fun jpeg(): ByteArray {
        val out = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(200, 150, BufferedImage.TYPE_INT_RGB), "jpeg", out)
        return out.toByteArray()
    }

    // --- what is printed, and where -------------------------------------------------------------------------

    @Test
    fun `the protocols are printed after the end of the entry and before what was added later, with their content, state and signatures`() = runBlocking<Unit> {
        val s = site()
        val meters = listOf(MeterState("Elektřina VT", "EL-98765", "12450 kWh"), MeterState("Voda", "VO-1", "310,5 m3"))
        val created = SiteHandoverService.createHandover(
            s.boss, s.projectId,
            handoverInput(type = "Předání staveniště", date = "2026-09-01", participants = "Jan Novák; Petr Svoboda", meterStates = meters, notes = "Staveniště předáno bez závad"),
        )
        val byContractor = signHandover(s.boss, created)
        Thread.sleep(5)
        val complete = signHandover(s.investor, byContractor)
        Thread.sleep(5)
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)
        AddendumService.create(s.boss, report, CreateAddendumRequest("Oprava množství betonu"))

        val text = textOf(pdfOf(report))

        val end = text.indexOf("Konec denního záznamu č. 1")
        val section = text.indexOf("Předání a převzetí staveniště")
        val after = text.indexOf("Připojeno po podpisu záznamu")
        assertTrue(end in 0 until section && section < after, "the entry ends, then the handover of the site, then what was added later ($end, $section, $after): $text")
        for (printed in listOf("Protokol č. 1", "Podpisy protokolu č. 1", "Staveniště předáno bez závad", "Elektřina VT", "EL-98765", "12450 kWh", "310,5 m3", "VO-1")) {
            assertTrue(text.indexOf(printed) > section, "'$printed' is in the section: $text")
        }
        assertTrue(Regex("""Typ předání:[^\n]*Předání staveniště""").containsMatchIn(text), text)
        assertTrue(Regex("""Datum předání:[^\n]*1\. 9\. 2026""").containsMatchIn(text), text)
        assertTrue(Regex("""Účastníci:[^\n]*Jan Novák; Petr Svoboda""").containsMatchIn(text), text)
        assertTrue(Regex("""Stav protokolu:[^\n]*podepsáno oběma stranami""").containsMatchIn(text), text)
        // Who signed for which side, in which role, with the number of the contractor's manager; the time in Prague with the zone.
        assertTrue(Regex("""Podpis strany zhotovitele:[^\n]*Ing\. Jan Stavbyvedoucí, stavbyvedoucí, ČKAIT 0012345""").containsMatchIn(text), text)
        assertTrue(Regex("""Podpis strany stavebníka:[^\n]*Marie Stavebníková, stavebník""").containsMatchIn(text), text)
        assertFalse(Regex("""Marie Stavebníková, stavebník, ČKAIT""").containsMatchIn(text), "the client has no number: $text")
        assertTrue(Regex("""\d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}:\d{2} SE?L?Č \(UTC\+[12]\)""").containsMatchIn(text.substring(section, after)), "Prague time with the zone: $text")
        // The hashes: of each signature, and of the content that both signed.
        val squeezedSection = squeezed(text.substring(section, after))
        for (hash in listOf(complete.contractorSignature!!.signatureHash, complete.clientSignature!!.signatureHash, complete.contractorSignature!!.contentHash)) {
            assertTrue(squeezedSection.contains(hash), "the hash $hash is printed: $text")
        }
        // The note says that the protocols are not part of the signature of the entry.
        assertTrue(squeezed(text).contains(squeezed("nejsou součástí podpisu tohoto záznamu")), text)
    }

    @Test
    fun `a protocol that one party signed says which one is missing`() = runBlocking<Unit> {
        val s = site()
        signHandover(s.boss, SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Předání sítí")))
        SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Rozpracovaný protokol", date = "2026-09-05"))
        val report = entry(s)

        val text = textOf(pdfOf(report))

        assertTrue(Regex("""Stav protokolu:[^\n]*zatím podepsáno jen stranou zhotovitele""").containsMatchIn(text), text)
        assertTrue(Regex("""Podpis strany stavebníka:[^\n]*zatím nepodepsáno""").containsMatchIn(text), text)
        assertTrue(Regex("""Stav protokolu:[^\n]*nepodepsáno""").containsMatchIn(text.substringAfter("Rozpracovaný protokol")), "the second protocol: $text")
        assertTrue(text.contains("Záznam ještě není podepsán"), "a draft says that all protocols are listed as they are: $text")
    }

    @Test
    fun `an entry of a project with no protocol has the heading, and says bez záznamu`() = runBlocking<Unit> {
        val s = site()
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)

        val text = textOf(pdfOf(report))

        val section = text.indexOf("Předání a převzetí staveniště")
        assertTrue(section > text.indexOf("Konec denního záznamu č. 1"), text)
        assertTrue(text.substring(section).contains("bez záznamu"), text)
        assertFalse(text.contains("Protokol č. 1"), text)
    }

    @Test
    fun `a protocol that was signed after the entry is not printed in it, and the other one is printed as it stood`() = runBlocking<Unit> {
        val s = site()
        val first = signHandover(s.boss, SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Předání staveniště")))
        Thread.sleep(5)
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)
        Thread.sleep(5)
        signHandover(s.investor, first)
        signHandover(s.boss, SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Pozdější předání", date = "2026-10-01")))

        val text = textOf(pdfOf(report))

        assertTrue(text.contains("Předání staveniště"), text)
        assertFalse(text.contains("Pozdější předání"), "a protocol that did not exist on the day of the entry: $text")
        assertTrue(Regex("""Stav protokolu:[^\n]*zatím podepsáno jen stranou zhotovitele""").containsMatchIn(text), "as it stood: $text")
        assertTrue(Regex("""Podpis strany stavebníka:[^\n]*zatím nepodepsáno""").containsMatchIn(text), "the signature of the client came later: $text")
    }

    @Test
    fun `hostile text in a protocol and in the names of its signers is printed as text`() = runBlocking<Unit> {
        val hostile = "#panic(\"X\") *tučně* \$ x \$"
        val s = site()
        dsl.update(USERS).set(USERS.DISPLAYNAME, hostile).where(USERS.ID.eq(s.boss.id)).execute()
        val created = SiteHandoverService.createHandover(
            s.boss, s.projectId,
            handoverInput(
                type = "#read(\"/etc/passwd\")", participants = "#include \"main.typ\"", notes = hostile,
                meterStates = listOf(MeterState("#panic(\"M\")", "*S*", "\$ y \$")),
            ),
        )
        signHandover(s.boss, created)
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)

        val text = textOf(pdfOf(report))

        for (printed in listOf("#read(\"/etc/passwd\")", "#include \"main.typ\"", hostile, "#panic(\"M\")", "*S*", "\$ y \$")) {
            assertTrue(squeezed(text).contains(squeezed(printed)), "'$printed' is printed as it was typed: $text")
        }
        assertFalse(text.contains("root:x"), "nothing was read from the machine")
    }

    // --- who wrote each record, and their number --------------------------------------------------------------

    @Test
    fun `the author, the uploader of a photo and whoever wrote or took note later are printed with the name and number they had then`() = runBlocking<Unit> {
        val s = site()
        val report = UUID.fromString(DailyReportService.createReport(s.worker, s.projectId, "2026-09-28", workDescription = "Betonáž").id)
        PhotoService.uploadPhoto(s.boss, report, jpeg(), "image/jpeg", "a.jpg")
        DailyReportService.signReport(s.boss, report)
        AddendumService.create(s.boss, report, CreateAddendumRequest("Oprava množství betonu"))
        RemarkService.create(s.inspector, report, CreateRemarkRequest(text = "Bez závad."))
        RemarkService.create(s.investor, report, CreateRemarkRequest(text = "Beru na vědomí."))
        RemarkService.create(s.boss, report, CreateRemarkRequest(text = "Kontrola stavebního úřadu.", externalAuthor = "Stavební úřad"))
        DailyReportService.acknowledgeReport(s.inspector, report)
        DailyReportService.acknowledgeReport(s.investor, report)
        // Afterwards everybody is renamed and their numbers are changed: none of it shows in the document.
        dsl.update(USERS).set(USERS.DISPLAYNAME, "Přejmenovaný").set(USERS.CKAITNUMBER, "9999999").execute()

        val text = textOf(pdfOf(report))

        assertTrue(Regex("""Autor záznamu:[^\n]*Pavel Dělník""").containsMatchIn(text), text)
        assertTrue(squeezed(text).contains(squeezed("Ing. Jan Stavbyvedoucí, 28.")) || Regex("""Ing\. Jan Stavbyvedoucí,\s+\d{1,2}\. \d{1,2}\. \d{4}""").containsMatchIn(text), "the uploader of the photo: $text")
        assertTrue(Regex("""Ing\. Jan Stavbyvedoucí, ČKAIT 0012345, \d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}:\d{2} SE?L?Č""").containsMatchIn(text), "the addendum: $text")
        assertTrue(Regex("""Ing\. Karel Dozor, ČKAIT 0077777, \d{1,2}\. \d{1,2}\. \d{4}""").containsMatchIn(text), "the entry of the supervision: $text")
        assertTrue(Regex("""Marie Stavebníková, \d{1,2}\. \d{1,2}\. \d{4}""").containsMatchIn(text), "the entry of the client, who has no number: $text")
        assertTrue(Regex("""Stavební úřad \(zapsal Ing\. Jan Stavbyvedoucí, ČKAIT 0012345\)""").containsMatchIn(text), "recorded for an outside party: $text")
        assertTrue(Regex("""Ing\. Karel Dozor, ČKAIT 0077777 \(dozor\)""").containsMatchIn(text), "the acknowledgement: $text")
        assertTrue(Regex("""Marie Stavebníková \(stavebník\)""").containsMatchIn(text), "the acknowledgement of the client: $text")
        assertFalse(text.contains("Přejmenovaný") || text.contains("9999999"), "nothing of the accounts as they are now: $text")
    }

    // --- the layout, with data made by hand (no database) -------------------------------------------------------

    private fun hex(n: Int) = "%02x".format(n).repeat(32)

    private fun protocol(
        number: Int, meters: Int, type: String = "Předání staveniště $number", participants: String = "Jan Novák, Petr Svoboda", notes: String = "Bez závad",
        meter: (Int) -> MeterPdf = { MeterPdf("Elektřina VT $it", "EL-%05d".format(it), "${12450 + it} kWh") },
        contractor: String = "Ing. Jan Stavbyvedoucí, stavbyvedoucí, ČKAIT 0012345",
    ) = HandoverPdf(
        date = "${1 + number % 28}. 9. 2026", type = type, participants = participants, notes = notes,
        meters = (1..meters).map(meter), state = "podepsáno oběma stranami", contentHash = hex(200 + number),
        contractor = HandoverSignaturePdf(contractor, "14. 10. 2026 14:32:07 SELČ (UTC+2)", hex(number)),
        client = HandoverSignaturePdf("Marie Stavebníková, stavebník", "14. 10. 2026 15:01:09 SELČ (UTC+2)", hex(100 + number)),
    )

    private fun dataOf(workDescription: String, handovers: List<HandoverPdf>) = ReportPdfData(
        projectName = "Bytový dům Zelená", address = "Karlova 15", date = "28. 9. 2026", weekday = "pondělí",
        sequenceNumber = 7, isSigned = true,
        isLateEntry = false, lateEntryReason = "", weather = "Neuvedeno", workDescription = workDescription,
        entryId = "00000000-0000-4000-8000-000000000007",
        signedBy = "Ing. Jan Stavbyvedoucí, ČKAIT 0012345", signedAt = "28. 9. 2026 14:32:07 SELČ (UTC+2)",
        // Not repetitions of one pair of characters, like the hashes of the protocols below: the page of a hash is found by it.
        signatureHash = "0123456789abcdef".repeat(4), auditRowHash = "fedcba9876543210".repeat(4),
        handovers = handovers, handoversNote = PdfExportService.handoversNote(signed = true),
    )

    private fun lines(count: Int) = (1..count).joinToString("\n") { "Řádek číslo $it popisu prací na stavbě." }

    private fun render(data: ReportPdfData): ByteArray = PdfExportService.render(data, UUID.randomUUID()).bytes

    /** The pages on which the caption of the signatures of protocol [number] and the hashes of its two signatures are: they have to be one. */
    private fun pagesOfSignaturesOf(number: Int, pages: List<String>): Triple<Int, Int, Int> = Triple(
        pages.indexOfFirst { Regex("(?m)^Podpisy protokolu č\\. $number$").containsMatchIn(it) },
        pages.indexOfFirst { squeezed(it).contains(hex(number)) },
        pages.indexOfFirst { squeezed(it).contains(hex(100 + number)) },
    )

    @Test
    fun `the signatures of a protocol are never split between two pages, wherever the page breaks`() {
        // Protocols of every length (0 to 50 meters) after entries of every length: wherever the break falls, the caption of the signatures
        // and the hashes of both sides are on one page (a block that may not break moves to the next page as a whole).
        val splits = mutableListOf<String>()
        for (entryLines in 20..110 step 9) {
            val handovers = (1..6).map { protocol(it, meters = (it * 9) % 51) }
            val pages = pagesOf(render(dataOf(lines(entryLines), handovers)))
            for (number in 1..6) {
                val (caption, contractor, client) = pagesOfSignaturesOf(number, pages)
                if (caption < 0 || caption != contractor || caption != client) splits += "$entryLines lines, protocol $number: caption on page $caption, hashes on $contractor and $client"
            }
        }
        assertEquals(emptyList<String>(), splits)
    }

    @Test
    fun `text without a space in a protocol breaks inside its cell, is all printed, and does not run over the edge of the page`() {
        // Each long text is made of a letter that is nowhere else in the document, so that the letters of the page can be counted.
        val handover = protocol(
            1, meters = 0, type = "Ť".repeat(SiteHandoverService.MAX_TYPE_CHARS), participants = "Ď".repeat(SiteHandoverService.MAX_PARTICIPANTS_CHARS),
            notes = "Ě".repeat(SiteHandoverService.MAX_NOTES_CHARS), contractor = "Ů".repeat(100) + ", stavbyvedoucí, ČKAIT 0012345",
        ).copy(
            meters = listOf(MeterPdf("Š".repeat(SiteHandoverService.MAX_METER_FIELD_CHARS), "Ž".repeat(SiteHandoverService.MAX_METER_FIELD_CHARS), "Ň".repeat(SiteHandoverService.MAX_METER_FIELD_CHARS))),
        )

        val pdf = render(dataOf("Betonáž", listOf(handover)))
        val text = squeezed(textOf(pdf))

        for ((letter, count) in listOf('Ť' to 200, 'Ď' to 2000, 'Ě' to 5000, 'Ů' to 100, 'Š' to 100, 'Ž' to 100, 'Ň' to 100)) {
            assertEquals(count, text.count { it == letter }, "every character of the text made of '$letter' is printed, once")
        }
        val (furthest, where) = rightmostPoint(pdf)
        assertTrue(furthest <= 595.28f - 56.69f + 1f, "the text reaches $furthest, past the margin: $where")
        val pages = pagesOf(pdf)
        val (caption, contractor, client) = pagesOfSignaturesOf(1, pages)
        assertTrue(caption >= 0 && caption == contractor && caption == client, "the signatures are on one page")
    }

    @Test
    fun `a project with the most protocols with the most meters is printed within the time limit, with every block of signatures whole`() {
        val handovers = (1..PdfExportService.MAX_HANDOVERS).map { protocol(it, meters = SiteHandoverService.MAX_METERS) }

        val started = System.nanoTime()
        val pdf = render(dataOf(lines(60), handovers))
        val seconds = (System.nanoTime() - started) / 1e9
        val pages = pagesOf(pdf)

        assertTrue(seconds < 20, "the render takes $seconds s")
        assertTrue(pages.size in 20..120, "the pages are ${pages.size}")
        val broken = (1..PdfExportService.MAX_HANDOVERS).filter { number ->
            val (caption, contractor, client) = pagesOfSignaturesOf(number, pages)
            caption < 0 || caption != contractor || caption != client
        }
        assertEquals(emptyList<Int>(), broken, "protocols whose block of signatures is split or missing")
        assertTrue(pages.last().contains("Strana ${pages.size} z ${pages.size}"))
        println("B9 measure: ${PdfExportService.MAX_HANDOVERS} protocols x ${SiteHandoverService.MAX_METERS} meters: ${pages.size} pages, %.1f s, ${pdf.size / 1024} KiB".format(seconds))
    }

    @Test
    fun `the most protocols with every text at its limit are printed within the time limit too`() {
        // The worst the application allows: 50 protocols, each with 50 meters whose three fields are 100 characters, participants of 2 000
        // characters and notes of 5 000, all of it words that wrap at the width of a cell.
        fun words(length: Int, seed: String) = (0..length).joinToString(" ") { "$seed$it-slovo" }.take(length)
        val handovers = (1..PdfExportService.MAX_HANDOVERS).map { number ->
            protocol(
                number, meters = SiteHandoverService.MAX_METERS, type = words(SiteHandoverService.MAX_TYPE_CHARS, "t"),
                participants = words(SiteHandoverService.MAX_PARTICIPANTS_CHARS, "u"), notes = words(SiteHandoverService.MAX_NOTES_CHARS, "n"),
                meter = { MeterPdf(words(SiteHandoverService.MAX_METER_FIELD_CHARS, "m"), words(SiteHandoverService.MAX_METER_FIELD_CHARS, "s"), words(SiteHandoverService.MAX_METER_FIELD_CHARS, "v")) },
            )
        }

        val started = System.nanoTime()
        val pdf = render(dataOf(lines(60), handovers))
        val seconds = (System.nanoTime() - started) / 1e9
        val pages = pagesOf(pdf)

        assertTrue(seconds < 20, "the render takes $seconds s")
        val broken = (1..PdfExportService.MAX_HANDOVERS).filter { number ->
            val (caption, contractor, client) = pagesOfSignaturesOf(number, pages)
            caption < 0 || caption != contractor || caption != client
        }
        assertEquals(emptyList<Int>(), broken, "protocols whose block of signatures is split or missing")
        println("B9 measure (every text at its limit): ${PdfExportService.MAX_HANDOVERS} protocols x ${SiteHandoverService.MAX_METERS} meters: ${pages.size} pages, %.1f s, ${pdf.size / 1024} KiB".format(seconds))
    }

    @Test
    fun `what was left out is said in a sentence next to the place it was left out of`() {
        val data = dataOf("Zápis", listOf(protocol(1, meters = 1).copy(cut = PrintBudget.omittedLines(12))))
            .copy(
                handoversLeftOut = 3, handoversLeftOutNote = PrintBudget.omittedProtocols(3),
                workDescriptionCut = PrintBudget.omittedLines(40), details = listOf(DetailPdf("Použité stroje a mechanizace", "Bagr", PrintBudget.omittedLines(1))),
                workers = listOf(WorkerPdf("Betonáři", 3, "Jan Novák")), workersCut = PrintBudget.omittedLines(2),
                constructionObjCut = PrintBudget.omittedLines(5),
                addenda = listOf(AddendumPdf("Ing. Jan Stavbyvedoucí", "29. 9. 2026 9:00:00 SELČ (UTC+2)", "Oprava", PrintBudget.omittedLines(7))),
                recordsLeftOutNote = PrintBudget.omittedRecords(4),
            )

        val text = squeezed(pagesOf(render(data)).joinToString("\n"))

        for (sentence in listOf(
            PrintBudget.omittedLines(12), PrintBudget.omittedProtocols(3), PrintBudget.omittedLines(40), PrintBudget.omittedLines(1), PrintBudget.omittedLines(2),
            PrintBudget.omittedLines(5), PrintBudget.omittedLines(7), PrintBudget.omittedRecords(4),
        )) {
            assertTrue(text.contains(squeezed(sentence)), "'$sentence' is printed: $text")
        }
    }

    @Test
    fun `the widest capitals in the fields of a meter stay inside their columns and inside the page`() {
        // W is the widest letter (10 pt at this size; M is 9); a cell is 148 pt wide inside its padding, and a word broke only every 16
        // characters, which is 158 pt of Ws: the last of them lay over the next column, and in the last column past the margin. (The
        // reviewer's case; the Ms of a second test column would be the letter of the header "Médium" and the name "Marie", so Ws are used.)
        val wide = MeterPdf("W".repeat(100), "W".repeat(100), "W".repeat(100))
        val pdf = render(dataOf("Betonáž", listOf(protocol(1, meters = 0).copy(meters = listOf(wide, wide)))))

        val (furthest, where) = rightmostPoint(pdf)
        assertTrue(furthest <= 595.28f - 56.69f + 1f, "the text reaches $furthest, past the margin: $where")
        // The table is 482 pt wide, from the left margin, in three columns of the same width with a padding of 6 pt: a W is wholly inside the
        // padding of one of them.
        val column = (595.28f - 2 * 56.69f) / 3
        val inside = (0..2).map { 56.69f + it * column + 6f..56.69f + (it + 1) * column - 6f }
        val outside = lettersOutside(pdf, mapOf('W' to inside))
        assertEquals(emptyList<String>(), outside, "letters that are not inside a column")
        // Every letter is there.
        assertEquals(600, squeezed(textOf(pdf)).count { it == 'W' }, "the Ws of two meters")
    }

    /** The letters among [allowed] that are not wholly inside one of the ranges that the letter may be in, with where. */
    private fun lettersOutside(pdf: ByteArray, allowed: Map<Char, List<ClosedFloatingPointRange<Float>>>): List<String> =
        org.apache.pdfbox.Loader.loadPDF(pdf).use { document ->
            val found = mutableListOf<String>()
            val stripper = object : org.apache.pdfbox.text.PDFTextStripper() {
                override fun writeString(text: String, textPositions: MutableList<org.apache.pdfbox.text.TextPosition>) {
                    for (position in textPositions) {
                        val ranges = position.unicode.singleOrNull()?.let { allowed[it] } ?: continue
                        val from = position.xDirAdj
                        val to = position.xDirAdj + position.widthDirAdj
                        if (ranges.none { from >= it.start - 0.5f && to <= it.endInclusive + 0.5f }) found += "'${position.unicode}' at $from..$to on page $currentPageNo"
                    }
                }
            }
            stripper.getText(document)
            found.take(5)
        }

    // --- the budget of lines, with the real typst ---------------------------------------------------------------------

    private fun repeated(count: Int, text: String) = (1..count).joinToString("\n") { "$text $it" }

    /** Both sides have signed the protocol (rows written by SQL, with hashes of the right shape: the point is the size of what is printed). */
    private fun signBothSides(s: Site, handover: UUID) {
        for ((side, user, role, ckait) in listOf(
            listOf("CONTRACTOR", s.boss.id, "BOSS", "0012345"), listOf("CLIENT", s.investor.id, "INVESTOR", null),
        )) {
            dsl.execute(
                """insert into site_handover_signatures ("handoverId", side, "signedById", "signerName", "signerRole", "signerCkaitNumber", "signedAt", "contentHash", "signatureHash")
                   values (?, ?, ?, ?, ?::"Role", ?, now(), repeat('a', 64), repeat('b', 64))""",
                handover, side, user, if (side == "CONTRACTOR") "Ing. Jan Stavbyvedoucí" else "Marie Stavebníková", role, ckait,
            )
        }
    }

    private fun meterJson(count: Int, field: (Int) -> Triple<String, String, String>): String =
        (1..count).joinToString(",", "[", "]") { n ->
            val (m, s, v) = field(n)
            """{"medium":${kotlinx.serialization.json.JsonPrimitive(m)},"serialNumber":${kotlinx.serialization.json.JsonPrimitive(s)},"state":${kotlinx.serialization.json.JsonPrimitive(v)}}"""
        }

    private fun storeProtocol(s: Site, number: Int, type: String, participants: String, notes: String, meters: String): UUID {
        val id = UUID.randomUUID()
        dsl.execute(
            """insert into site_handovers (id, "projectId", type, date, participants, "meterStates", notes, "createdById") values (?, ?, ?, ?::date, ?, ?::jsonb, ?, ?)""",
            id, s.projectId, type, java.time.LocalDate.of(2026, 1, 1).plusDays(number.toLong()).toString(), participants, meters, notes, s.boss.id,
        )
        signBothSides(s, id)
        return id
    }

    /** The pages and the seconds the real typst takes for an entry, and what it printed. */
    private class Measured(val pages: List<String>, val seconds: Double, val kib: Int) {
        val text: String get() = pages.joinToString("\n")
    }

    private suspend fun measure(report: UUID): Measured {
        val started = System.nanoTime()
        val pdf = pdfOf(report)
        val seconds = (System.nanoTime() - started) / 1e9
        return Measured(pagesOf(pdf), seconds, pdf.size / 1024)
    }

    @Test
    fun `fifty protocols stored with newlines past every limit are printed within the budget, with a sentence, in a few dozen pages`() = runBlocking<Unit> {
        val s = site()
        // What the reviewer found: 50 protocols, a type of 100 lines, participants of 1 000 lines, notes of 2 500 lines and 50 meters of
        // 50 lines in each of three fields. Past the limits that are checked at the time of saving, so written by SQL.
        val huge = meterJson(50) { Triple(repeated(50, "m"), repeated(50, "s"), repeated(50, "v")) }
        repeat(PdfExportService.MAX_HANDOVERS) { n ->
            storeProtocol(s, n + 1, type = repeated(100, "typ"), participants = "u" + "\n".repeat(1000) + "u", notes = "n" + "\n".repeat(2500) + "n", meters = huge)
        }
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)

        val measured = measure(report)

        println("B9 measure (stored with newlines, 50 protocols): ${measured.pages.size} pages, %.1f s, ${measured.kib} KiB".format(measured.seconds))
        assertTrue(measured.pages.size <= 150, "the pages are ${measured.pages.size}")
        assertTrue(measured.seconds < 20, "the render takes ${measured.seconds} s")
        assertTrue(measured.text.contains("do tohoto výtisku nevešl"), "the cut is said")
        assertTrue(Regex("""a dalších? \d+ protokol[a-zů]* se do tohoto výtisku nevešl""").containsMatchIn(measured.text.replace(Regex("\\s+"), " ")), "the protocols that did not fit are counted")
        assertTrue(measured.text.contains("Protokol č. 1"), "the first protocol is printed")
        assertTrue(measured.text.contains("Podpisy protokolu č. 1"))
    }

    @Test
    fun `the largest protocols that the limits allow, fifty of them, are printed within the budget too, in fewer than 150 pages`() = runBlocking<Unit> {
        val s = site()
        // 100 lines of participants and 200 of notes at the limit of their characters, 50 meters of three fields of 100 characters, a type of 200.
        fun words(length: Int, seed: String) = (0..length).joinToString(" ") { "$seed$it-slovo" }.take(length)
        val participants = (1..SiteHandoverService.MAX_PARTICIPANTS_LINES).joinToString("\n") { words(19, "u$it") }
        val notes = (1..SiteHandoverService.MAX_NOTES_LINES).joinToString("\n") { words(24, "n$it") }
        val meters = (1..SiteHandoverService.MAX_METERS).map { MeterState(words(100, "m$it"), words(100, "s$it"), words(100, "v$it")) }
        repeat(PdfExportService.MAX_HANDOVERS) { n ->
            val created = SiteHandoverService.createHandover(
                s.boss, s.projectId,
                handoverInput(type = words(200, "t"), date = java.time.LocalDate.of(2026, 1, 1).plusDays(n.toLong()).toString(), participants = participants, notes = notes, meterStates = meters),
            )
            signHandover(s.investor, signHandover(s.boss, created))
        }
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)

        val measured = measure(report)

        println("B9 measure (the largest legal protocols, 50): ${measured.pages.size} pages, %.1f s, ${measured.kib} KiB".format(measured.seconds))
        assertTrue(measured.pages.size <= 150, "the pages are ${measured.pages.size}")
        assertTrue(measured.seconds < 20, "the render takes ${measured.seconds} s")
        assertTrue(measured.text.contains("do tohoto výtisku nevešl"), "what did not fit is said: the budget is smaller than fifty of these")
    }

    @Test
    fun `an entry whose texts are thousands of lines and a record after it that are thousands of lines are printed within their budgets`() = runBlocking<Unit> {
        val s = site()
        val huge = "x" + "\n".repeat(4998) + "y"
        val details = mapOf("materials" to huge, "machinery" to huge, "testsAndChecks" to huge, "safetyNotes" to huge, "dustMeasures" to huge, "accessibilityMeasures" to huge, "defects" to huge, "workStateChanges" to huge, "otherNotes" to huge)
        val report = UUID.fromString(
            DailyReportService.saveReport(
                s.boss, s.projectId, "2026-09-28",
                DailyReportService.ReportInput(workDescription = "x" + "\n".repeat(100_000) + "y", details = details),
            ).id,
        )
        dsl.execute(
            """update daily_reports set "workersByTrade" = ?::jsonb where id = ?""",
            """[{"trade":"Betonáři","count":131,"names":[${(1..131).joinToString(",") { "\"Jan${"\\n".repeat(98)}$it\"" }}]}]""", report,
        )
        DailyReportService.signReport(s.boss, report)
        repeat(30) { n ->
            dsl.execute(
                """insert into addenda ("reportId", "authorId", "authorName", text) values (?, ?, 'Pavel Dělník', ?)""",
                report, s.worker.id, "x" + "\n".repeat(3998) + "dodatek $n",
            )
        }

        val measured = measure(report)

        println("B9 measure (an entry of newlines and 30 addenda of newlines): ${measured.pages.size} pages, %.1f s, ${measured.kib} KiB".format(measured.seconds))
        assertTrue(measured.pages.size <= 250, "the pages are ${measured.pages.size}")
        assertTrue(measured.seconds < 20, "the render takes ${measured.seconds} s")
        assertTrue(measured.pages.last().contains("Strana ${measured.pages.size} z ${measured.pages.size}"))
        val text = measured.text.replace(Regex("\\s+"), " ")
        assertTrue(text.contains("do tohoto výtisku nevešl"), "the cut is said")
        assertTrue(Regex("""a dalších? \d+ záznam[a-zů]* se do tohoto výtisku nevešl""").containsMatchIn(text), "the addenda that did not fit are counted")
        // The signature of the entry is whole, whatever was cut from the text.
        assertTrue(text.contains("Konec denního záznamu č. 1"))
    }
}
