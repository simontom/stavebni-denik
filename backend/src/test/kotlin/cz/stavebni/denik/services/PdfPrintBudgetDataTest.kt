package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.util.UUID

/**
 * What the PDF is given when a text has more lines than the document may print (backlog B9, review): the limits at the time of saving
 * keep new text out of it, so these are texts that are stored already (written here by SQL, past the limits) and the fields that have
 * no limit of lines. Everything is cut to a budget of printed lines, and what is cut is said in a sentence next to it, never silently.
 * The pages that the real typst makes of it are measured in `RealTypstHandoversPdfTest`.
 */
class PdfPrintBudgetDataTest : BaseIntegrationTest() {

    private class Site(val projectId: UUID, val boss: SessionUser, val worker: SessionUser)

    private suspend fun site(): Site {
        val boss = createTestUser(nickname = "boss", displayName = "Ing. Jan Stavbyvedoucí", role = Role.BOSS, ckaitNumber = "0012345")
        val worker = createTestUser(nickname = "worker", displayName = "Pavel Dělník", role = Role.WORKER)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Stavba", address = "Ulice 1", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        addMember(projectId, worker)
        return Site(projectId, boss, worker)
    }

    private suspend fun dataOf(reportId: UUID): JsonObject {
        var data = ""
        PdfExportService.compiler = TypstCompiler { dir, _, pdfFile ->
            data = File(dir, "data.json").readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }
        PdfExportService.generateReportPdf(dsl, reportId)
        return Json.parseToJsonElement(data).jsonObject
    }

    private suspend fun entry(s: Site, day: String = "2026-09-28", description: String = "Betonáž", details: Map<String, String>? = null): UUID =
        UUID.fromString(
            DailyReportService.saveReport(s.boss, s.projectId, day, DailyReportService.ReportInput(workDescription = description, details = details)).id,
        )

    private fun JsonObject.text(key: String): String = getValue(key).jsonPrimitive.content

    private fun JsonObject.list(key: String): List<JsonObject> = getValue(key).jsonArray.map { it.jsonObject }

    private fun lines(count: Int, text: String = "x") = (1..count).joinToString("\n") { "$text $it" }

    /** The lines a printed text takes of the budget (the ellipsis that stands in the place of a text that did not fit costs nothing). */
    private fun printedLines(text: String, charsPerLine: Int) = if (text == "…") 0 else PrintBudget.linesOf(text, charsPerLine)

    /** A protocol written past the limits of the lines (SQL: the application refuses it now, a row stored earlier may be like it). */
    private fun storeProtocol(s: Site, number: Int, type: String = "Protokol $number", participants: String, notes: String, meters: List<Triple<String, String, String>> = emptyList()) {
        val json = meters.joinToString(",", "[", "]") { (m, serial, state) ->
            """{"medium":${JsonPrimitive(m)},"serialNumber":${JsonPrimitive(serial)},"state":${JsonPrimitive(state)}}"""
        }
        dsl.execute(
            """insert into site_handovers ("projectId", type, date, participants, "meterStates", notes, "createdById") values (?, ?, ?::date, ?, ?::jsonb, ?, ?)""",
            s.projectId, type, java.time.LocalDate.of(2026, 1, 1).plusDays(number.toLong()).toString(), participants, if (meters.isEmpty()) null else json, notes, s.boss.id,
        )
    }

    // --- the protocols --------------------------------------------------------------------------------------------

    @Test
    fun `protocols of an ordinary size are printed whole, fifty of them too, with nothing said about a cut`() = runBlocking<Unit> {
        val s = site()
        repeat(PdfExportService.MAX_HANDOVERS) { n ->
            storeProtocol(s, n + 1, participants = lines(20, "Účastník"), notes = lines(30, "Poznámka"), meters = (1..10).map { Triple("Voda $it", "V-$it", "$it m3") })
        }

        val data = dataOf(entry(s))

        assertEquals(PdfExportService.MAX_HANDOVERS, data.list("handovers").size)
        assertEquals(0, data.getValue("handoversLeftOut").jsonPrimitive.int)
        assertEquals("", data.text("handoversLeftOutNote"))
        assertTrue(data.list("handovers").all { it.text("cut") == "" })
        assertEquals(lines(30, "Poznámka"), data.list("handovers").last().text("notes"))
    }

    @Test
    fun `a protocol with more lines than it may have is cut, and the cut is said in a sentence`() = runBlocking<Unit> {
        val s = site()
        storeProtocol(
            s, 1, type = lines(40, "typ"), participants = "\n".repeat(5000) + "u", notes = "\n".repeat(5000) + "n",
            meters = (1..50).map { Triple(lines(30, "m"), lines(30, "s"), lines(30, "v")) },
        )

        val protocol = dataOf(entry(s)).list("handovers").single()

        for (field in listOf("type", "participants", "notes")) {
            assertTrue(PrintBudget.linesOf(protocol.text(field), 40) < 1000, "$field is cut: ${PrintBudget.linesOf(protocol.text(field), 40)} lines")
        }
        assertTrue(PrintBudget.linesOf(protocol.text("type"), 40) <= 3, "a type is a line or a few")
        val meters = protocol.list("meters")
        assertTrue(meters.all { PrintBudget.linesOf(it.text("medium"), 20) <= 6 }, "the fields of a meter are cut")
        assertTrue(meters.size <= 50)
        val cut = protocol.text("cut")
        assertTrue(Regex("""^… a dalších \d+ řádků se do tohoto výtisku nevešlo; úplné znění je v aplikaci\.$""").matches(cut), cut)
        // What is cut is counted: the two texts alone were ten thousand lines.
        assertTrue(Regex("""\d+""").find(cut)!!.value.toInt() > 10_000, cut)
    }

    @Test
    fun `the whole section never prints more lines than its budget, whatever the protocols hold, and the protocols that do not fit are counted`() = runBlocking<Unit> {
        val s = site()
        repeat(PdfExportService.MAX_HANDOVERS) { n ->
            storeProtocol(
                s, n + 1, participants = "\n".repeat(1000) + "u", notes = "\n".repeat(2500) + "n",
                meters = (1..50).map { Triple(lines(50, "m"), lines(50, "s"), lines(50, "v")) },
            )
        }

        val data = dataOf(entry(s))

        val printed = data.list("handovers")
        val spent = printed.sumOf { protocol ->
            printedLines(protocol.text("type"), 40) + printedLines(protocol.text("participants"), 40) + printedLines(protocol.text("notes"), 40) +
                protocol.list("meters").sumOf { maxOf(printedLines(it.text("medium"), 20), printedLines(it.text("serialNumber"), 20), printedLines(it.text("state"), 20)) }
        }
        assertTrue(spent <= PdfExportService.HANDOVER_BUDGET_LINES, "the section prints $spent lines of text, its budget is ${PdfExportService.HANDOVER_BUDGET_LINES}")
        assertTrue(printed.isNotEmpty() && printed.size < PdfExportService.MAX_HANDOVERS, "some protocols are printed, not all: ${printed.size}")
        assertEquals(PdfExportService.MAX_HANDOVERS - printed.size, data.getValue("handoversLeftOut").jsonPrimitive.int)
        assertTrue(Regex("""… a dalších \d+ protokolů se do tohoto výtisku nevešlo; úplné znění je v aplikaci\.""").matches(data.text("handoversLeftOutNote")), data.text("handoversLeftOutNote"))
        // Every protocol that is printed has its signatures and its content hash, whatever was cut from its text.
        assertTrue(printed.all { it.text("state") == "nepodepsáno" })
    }

    // --- the entry --------------------------------------------------------------------------------------------------

    @Test
    fun `an ordinary entry, with long texts, is printed whole`() = runBlocking<Unit> {
        val s = site()
        val long = (1..60).joinToString("\n") { "Řádek číslo $it popisu prací na stavbě, který je docela dlouhý a zabere několik slov." }.take(5000).trim()
        val data = dataOf(entry(s, description = long, details = mapOf("materials" to long, "defects" to long)))

        assertEquals(long, data.text("workDescription"))
        assertEquals("", data.text("workDescriptionCut"))
        assertTrue(data.list("details").all { it.text("cut") == "" })
        assertEquals(long, data.list("details").first { it.text("text").isNotEmpty() }.text("text"))
    }

    @Test
    fun `a work description and fields of the entry that are thousands of lines are cut to the budget of the entry, with a sentence`() = runBlocking<Unit> {
        val s = site()
        // 5 000 characters of a field, nearly all of them line breaks (the text is trimmed, so it starts and ends with a letter).
        val huge = "x" + "\n".repeat(4998) + "y"
        val details = mapOf("materials" to huge, "machinery" to huge, "testsAndChecks" to huge, "safetyNotes" to huge, "dustMeasures" to huge, "accessibilityMeasures" to huge, "defects" to huge, "workStateChanges" to huge, "otherNotes" to huge)
        // The work description has no limit of characters but the size of a request: this one is a hundred thousand lines.
        val data = dataOf(entry(s, description = "\n".repeat(100_000) + "konec", details = details))

        val spent = printedLines(data.text("workDescription"), 60) + data.list("details").sumOf { printedLines(it.text("text"), 60) }
        assertTrue(spent <= PdfExportService.ENTRY_BUDGET_LINES, "the entry prints $spent lines of text, its budget is ${PdfExportService.ENTRY_BUDGET_LINES}")
        // A text of which nothing fits is not an empty place ("bez záznamu"): it is an ellipsis with the sentence under it.
        val exhausted = data.list("details").filter { it.text("text") == "…" }
        assertTrue(exhausted.isNotEmpty() && exhausted.all { it.text("cut").contains("se do tohoto výtisku nevešlo") }, data.list("details").toString())
        assertTrue(data.text("workDescriptionCut").contains("se do tohoto výtisku nevešlo"), data.text("workDescriptionCut"))
        val cut = data.list("details").map { it.text("cut") }
        assertTrue(cut.any { it.contains("se do tohoto výtisku nevešlo") }, cut.toString())
        assertTrue(PrintBudget.linesOf(data.text("workDescription"), 60) <= PdfExportService.ENTRY_FIELD_CAP_LINES)
    }

    @Test
    fun `the names and the trades of the workers are cut as well, and the table says so`() = runBlocking<Unit> {
        val s = site()
        val id = entry(s)
        dsl.execute(
            """update daily_reports set "workersByTrade" = ?::jsonb where id = ?""",
            """[{"trade":"Betonáři","count":200,"names":[${(1..200).joinToString(",") { "\"Jan${"\\n".repeat(98)}$it\"" }}]}]""", id,
        )

        val data = dataOf(id)

        val workers = data.list("workers")
        assertEquals(1, workers.size)
        assertTrue(PrintBudget.linesOf(workers.single().text("names"), 30) <= 100, "a trade's names are cut")
        assertTrue(data.text("workersCut").contains("se do tohoto výtisku nevešlo"), data.text("workersCut"))
        assertEquals(200, workers.single().getValue("count").jsonPrimitive.int, "the count of the people is the count, not what is printed")
    }

    // --- what is added after the signature --------------------------------------------------------------------------

    @Test
    fun `addenda and entries of other parties are cut to their budget, and the records that do not fit are counted`() = runBlocking<Unit> {
        val s = site()
        val report = entry(s)
        signUnchecked(s.boss, report)
        repeat(30) { n ->
            dsl.execute(
                """insert into addenda ("reportId", "authorId", "authorName", text) values (?, ?, 'Pavel Dělník', ?)""",
                report, s.worker.id, "\n".repeat(3999) + "dodatek $n",
            )
        }

        val data = dataOf(report)

        val addenda = data.list("addenda")
        val spent = addenda.sumOf { printedLines(it.text("text"), 60) }
        assertTrue(spent <= PdfExportService.RECORDS_BUDGET_LINES, "the addenda print $spent lines, their budget is ${PdfExportService.RECORDS_BUDGET_LINES}")
        assertTrue(addenda.isNotEmpty() && addenda.size < 30, "${addenda.size}")
        assertTrue(addenda.first().text("cut").contains("se do tohoto výtisku nevešlo"), addenda.first().text("cut"))
        assertTrue(Regex("""… a dalších? \d+ záznam[a-zů]* se do tohoto výtisku nevešl[oy]?; úplné znění je v aplikaci\.""").matches(data.text("recordsLeftOutNote")), data.text("recordsLeftOutNote"))
    }
}
