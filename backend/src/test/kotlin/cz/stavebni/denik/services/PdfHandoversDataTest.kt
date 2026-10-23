package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.util.UUID

/**
 * What the PDF of an entry is given about the site handover protocols (příloha 12 B.2 a), backlog B9): which protocols belong to
 * which entry, what is printed of each, and who signed (name, role, ČKAIT number for the contractor, time in Prague, hash). The
 * data of the template is read from `data.json`; `RealTypstPdfTest` checks the printed text.
 */
class PdfHandoversDataTest : BaseIntegrationTest() {

    private class Site(
        val projectId: UUID,
        val boss: SessionUser,
        val investor: SessionUser,
        val inspector: SessionUser,
    )

    private suspend fun site(tag: String = ""): Site {
        val boss = createTestUser(nickname = "boss$tag", displayName = "Ing. Jan Stavbyvedoucí", role = Role.BOSS, ckaitNumber = "0012345")
        val investor = createTestUser(nickname = "investor$tag", displayName = "Marie Stavebníková", role = Role.INVESTOR)
        val inspector = createTestUser(nickname = "dozor$tag", displayName = "Ing. Karel Dozor", role = Role.INSPECTOR, ckaitNumber = "0077777")
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Stavba", address = "Ulice 1", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        addMember(projectId, investor)
        addMember(projectId, inspector)
        return Site(projectId, boss, investor, inspector)
    }

    private suspend fun entry(s: Site, day: String = "2026-09-28"): UUID =
        UUID.fromString(DailyReportService.createReport(s.boss, s.projectId, day, workDescription = "Betonáž").id)

    /** The data the template is given for [reportId]. */
    private suspend fun dataOf(reportId: UUID): JsonObject {
        var data = ""
        PdfExportService.compiler = TypstCompiler { dir, _, pdfFile ->
            data = File(dir, "data.json").readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }
        PdfExportService.generateReportPdf(dsl, reportId)
        return Json.parseToJsonElement(data).jsonObject
    }

    private fun JsonObject.text(key: String): String = getValue(key).jsonPrimitive.content

    private fun JsonObject.handovers(): List<JsonObject> = getValue("handovers").jsonArray.map { it.jsonObject }

    private fun JsonObject.sign(side: String): JsonObject? = getValue(side).takeUnless { it is JsonNull }?.jsonObject

    /** Two writes never get the same millisecond, so "at or before the entry was signed" is decided by the order of the steps. */
    private fun tick() = Thread.sleep(5)

    private suspend fun handover(s: Site, type: String, date: String = "2026-09-01", participants: String = "Novák, Svoboda", meters: List<MeterState>? = null, notes: String? = null) =
        SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = type, date = date, participants = participants, meterStates = meters, notes = notes))

    // --- which protocols belong to which entry ----------------------------------------------------------

    @Test
    fun `a signed entry is given the protocols that were signed when it was signed, as they stood then, and a draft is given all of them`() = runBlocking<Unit> {
        val s = site()
        val complete = handover(s, "Předání staveniště", date = "2026-09-01")
        val oneSide = handover(s, "Předání sítí", date = "2026-09-02")
        val unsigned = handover(s, "Rozpracovaný protokol", date = "2026-09-03")
        val deleted = handover(s, "Smazaný protokol", date = "2026-09-04")
        SiteHandoverService.deleteHandover(s.boss, deleted.uuid)
        signHandover(s.boss, complete); tick(); signHandover(s.investor, SiteHandoverService.getHandover(dsl, s.boss, complete.uuid)!!); tick()
        signHandover(s.boss, oneSide); tick()
        val report = entry(s)

        // A draft: every current protocol, with its state, also the one that nobody signed; not the deleted one.
        val draft = dataOf(report).handovers()
        assertEquals(listOf("Předání staveniště", "Předání sítí", "Rozpracovaný protokol"), draft.map { it.text("type") })
        assertEquals(
            listOf("podepsáno oběma stranami", "zatím podepsáno jen stranou zhotovitele", "nepodepsáno"),
            draft.map { it.text("state") },
        )

        DailyReportService.signReport(s.boss, report); tick()
        // Afterwards: the other party signs the second protocol, a protocol is made and signed, another one is made and not signed.
        signHandover(s.inspector, SiteHandoverService.getHandover(dsl, s.boss, oneSide.uuid)!!); tick()
        val later = handover(s, "Pozdější protokol", date = "2026-10-01")
        signHandover(s.boss, later)
        handover(s, "Pozdější koncept", date = "2026-10-02")

        val signed = dataOf(report)
        val printed = signed.handovers()
        assertEquals(listOf("Předání staveniště", "Předání sítí"), printed.map { it.text("type") }, "the ones signed by then; none that did not exist, none that nobody had signed")
        assertEquals(listOf("podepsáno oběma stranami", "zatím podepsáno jen stranou zhotovitele"), printed.map { it.text("state") })
        // The second protocol shows what it was on the day: the signature that came after the entry is not printed as if it had been there.
        assertNotNull(printed[1].sign("contractor"))
        assertNull(printed[1].sign("client"), "the signature of the client came after the entry was signed")
        assertEquals(0, signed.getValue("handoversLeftOut").jsonPrimitive.int)
        // A draft made today is given all of them, as they are now, the second protocol complete.
        val draftToday = dataOf(entry(s, "2026-09-29")).handovers()
        assertEquals(5, draftToday.size)
        assertEquals("podepsáno oběma stranami", draftToday[1].text("state"))
    }

    @Test
    fun `a signed entry with no protocol signed by then says so, and so does a draft with none`() = runBlocking<Unit> {
        val s = site()
        val report = entry(s)
        assertTrue(dataOf(report).handovers().isEmpty())
        DailyReportService.signReport(s.boss, report); tick()
        // A protocol signed later does not exist on the day of the entry.
        signHandover(s.boss, handover(s, "Pozdější"))

        val data = dataOf(report)

        assertTrue(data.handovers().isEmpty())
        assertTrue(data.text("handoversNote").contains("ke dni podpisu záznamu"), data.text("handoversNote"))
    }

    @Test
    fun `the note says whether it is the state of the day of signing or of now, and that the protocols have their own signatures`() = runBlocking<Unit> {
        val s = site()
        val report = entry(s)

        val draft = dataOf(report).text("handoversNote")
        assertTrue(draft.contains("ještě není podepsán"), draft)
        assertTrue(draft.contains("vlastní podpisy"), draft)

        DailyReportService.signReport(s.boss, report)
        val signed = dataOf(report).text("handoversNote")
        assertTrue(signed.contains("nejsou součástí podpisu tohoto záznamu"), signed)
        assertTrue(signed.contains("ke dni podpisu záznamu"), signed)
        assertFalse(signed.contains("ještě není podepsán"), signed)
    }

    // --- what is printed of one protocol ----------------------------------------------------------------

    @Test
    fun `a protocol is printed with its day, type, participants, notes, meters, state, hashes and who signed`() = runBlocking<Unit> {
        val s = site()
        val meters = listOf(MeterState("Elektřina VT", "EL-98765", "12450 kWh"), MeterState("Voda", "VO-1", "310,5 m3"))
        val created = handover(s, "Předání staveniště", date = "2026-09-01", participants = "Novák, Svoboda", meters = meters, notes = "Bez závad")
        val byContractor = signHandover(s.boss, created); tick()
        val complete = signHandover(s.inspector, byContractor)
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)

        val protocol = dataOf(report).handovers().single()

        assertEquals("1. 9. 2026", protocol.text("date"))
        assertEquals("Předání staveniště", protocol.text("type"))
        assertEquals("Novák, Svoboda", protocol.text("participants"))
        assertEquals("Bez závad", protocol.text("notes"))
        assertEquals(
            listOf("Elektřina VT" to "EL-98765", "Voda" to "VO-1"),
            protocol.getValue("meters").jsonArray.map { it.jsonObject.text("medium") to it.jsonObject.text("serialNumber") },
        )
        assertEquals("12450 kWh", protocol.getValue("meters").jsonArray[0].jsonObject.text("state"))
        assertEquals("podepsáno oběma stranami", protocol.text("state"))
        assertEquals(complete.contractorSignature!!.contentHash, protocol.text("contentHash"))
        // The contractor: name, the role in the project, the ČKAIT number, the time in Prague with the zone, the hash of the signature.
        val contractor = protocol.sign("contractor")!!
        assertEquals("Ing. Jan Stavbyvedoucí, stavbyvedoucí, ČKAIT 0012345", contractor.text("signedBy"))
        assertTrue(Regex("""\d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}:\d{2} SE?L?Č \(UTC\+[12]\)""").matches(contractor.text("at")), contractor.text("at"))
        assertEquals(complete.contractorSignature!!.signatureHash, contractor.text("signatureHash"))
        // The client's side: the technical supervision acts for the builder; it has no number stored, and none is printed.
        val client = protocol.sign("client")!!
        assertEquals("Ing. Karel Dozor, technický dozor", client.text("signedBy"))
        assertEquals(complete.clientSignature!!.signatureHash, client.text("signatureHash"))
    }

    @Test
    fun `the people who signed are printed as the signatures stored them, not as their accounts are now`() = runBlocking<Unit> {
        val s = site()
        val signed = signHandover(s.boss, handover(s, "Předání staveniště")); tick()
        signHandover(s.investor, signed)
        dsl.execute("""update users set "displayName" = 'Změněné Jméno', "ckaitNumber" = '7777777'""")
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)

        val protocol = dataOf(report).handovers().single()

        assertEquals("Ing. Jan Stavbyvedoucí, stavbyvedoucí, ČKAIT 0012345", protocol.sign("contractor")!!.text("signedBy"))
        assertEquals("Marie Stavebníková, stavebník", protocol.sign("client")!!.text("signedBy"))
    }

    @Test
    fun `a protocol nobody signed is printed with no signatures and no content hash`() = runBlocking<Unit> {
        val s = site()
        handover(s, "Rozpracovaný protokol")

        val protocol = dataOf(entry(s)).handovers().single()

        assertEquals("nepodepsáno", protocol.text("state"))
        assertNull(protocol.sign("contractor"))
        assertNull(protocol.sign("client"))
        assertEquals("", protocol.text("contentHash"))
        assertEquals("", protocol.text("notes"), "no notes: nothing is printed in their place")
        assertTrue(protocol.getValue("meters").jsonArray.isEmpty())
    }

    @Test
    fun `an enormous name of a signer is cut, so that the block of the signatures has a known height`() = runBlocking<Unit> {
        val s = site()
        dsl.execute("""update users set "displayName" = ? where id = ?""", "Jan Novák ".repeat(400), s.boss.id)
        signHandover(s.boss, handover(s, "Předání staveniště"))

        val signedBy = dataOf(entry(s)).handovers().single().sign("contractor")!!.text("signedBy")

        assertTrue(signedBy.contains("…"), signedBy.take(200))
        assertTrue(signedBy.length < 300, "${signedBy.length}")
        assertTrue(signedBy.endsWith("ČKAIT 0012345"), signedBy.takeLast(40))
    }

    // --- how many ---------------------------------------------------------------------------------------

    @Test
    fun `at most as many protocols as the document may hold are printed, the oldest day first, and the rest is counted`() = runBlocking<Unit> {
        val s = site()
        val total = PdfExportService.MAX_HANDOVERS + 2
        repeat(total) { n -> handover(s, "Protokol ${n + 1}", date = java.time.LocalDate.of(2026, 1, 1).plusDays(n.toLong()).toString()) }

        val data = dataOf(entry(s))

        assertEquals(PdfExportService.MAX_HANDOVERS, data.handovers().size)
        assertEquals("Protokol 1", data.handovers().first().text("type"))
        assertEquals("Protokol ${PdfExportService.MAX_HANDOVERS}", data.handovers().last().text("type"))
        assertEquals(2, data.getValue("handoversLeftOut").jsonPrimitive.int)
    }

    @Test
    fun `the protocols of another project are never printed`() = runBlocking<Unit> {
        val s = site()
        val other = site("2")
        handover(other, "Cizí protokol")
        handover(s, "Vlastní protokol")

        val printed = dataOf(entry(s)).handovers().map { it.text("type") }

        assertEquals(listOf("Vlastní protokol"), printed)
    }
}
