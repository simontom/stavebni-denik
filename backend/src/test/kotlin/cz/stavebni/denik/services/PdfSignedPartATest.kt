package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.util.UUID

/**
 * What the PDF is given about part A and the signer (the data of the template, `ReportPdfData`): from format 3 on part A comes
 * from the snapshot stored at signing and the signer from the stored name and number; a draft and the older formats are
 * read from the project and the account as they are now, as before, with the same rows.
 */
class PdfSignedPartATest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val projectId: UUID)

    private suspend fun site(bossName: String = "Jan Stavbyvedoucí"): Site {
        val boss = createTestUser(nickname = "boss", displayName = bossName, role = Role.BOSS, ckaitNumber = "0012345")
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Bytový dům Zelená", address = "Zelená 1", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník a.s.", contractor = "Zhotovitel s.r.o.", siteManagerId = boss.id.toString(),
                permitNumber = "SZ/1", permitDate = "2026-03-15", authorSupervisionName = "Ing. arch. Petr Dozor", authorSupervisionAuthorization = "ČKA 123",
                subcontractors = "Elektro s.r.o.", supportingDocuments = "Smlouva o dílo",
            ),
        )
        return Site(boss, UUID.fromString(project.id))
    }

    private suspend fun entry(s: Site, day: String = "2026-09-28"): UUID =
        UUID.fromString(DailyReportService.saveReport(s.boss, s.projectId, day, DailyReportService.ReportInput(workDescription = "Betonáž")).id)

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

    private fun JsonObject.rows(key: String): Map<String, String> = getValue(key).jsonArray.associate { it.jsonObject.getValue("label").jsonPrimitive.content to it.jsonObject.getValue("value").jsonPrimitive.content }

    private fun JsonObject.text(key: String): String = getValue(key).jsonPrimitive.content

    private fun JsonObject.names(key: String): List<String> = getValue(key).jsonArray.map { it.jsonObject.getValue("name").jsonPrimitive.content }

    private suspend fun withPersons(s: Site): SessionUser {
        val supervisor = createTestUser(nickname = "dozor", displayName = "Ing. Karel Dozor", role = Role.INSPECTOR, ckaitNumber = null)
        val deputy = createTestUser(nickname = "deputy", displayName = "Marie Zástupce", role = Role.BOSS, ckaitNumber = "0099999")
        ProjectMemberService.addMember(s.boss, s.projectId, AddMemberRequest(supervisor.id.toString(), "INSPECTOR", "Technický dozor stavebníka"))
        ProjectMemberService.addMember(s.boss, s.projectId, AddMemberRequest(deputy.id.toString(), "BOSS", "Zástupce, objekty SO 02 a SO 03"))
        AuthorizedPersonService.create(s.boss, s.projectId, CreateAuthorizedPersonRequest("Eva Koordinátorka", "BOZP s.r.o.", "Koordinátor BOZP"))
        return supervisor
    }

    // --- format 3 -------------------------------------------------------------------------------------

    @Test
    fun `a signed entry is given part A as it stood on the day of signing, whatever happened to the project afterwards`() = runBlocking<Unit> {
        val s = site()
        withPersons(s)
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)

        // Afterwards: the project is renamed and its contractor changed, the persons are revoked, removed and rewritten.
        val current = ProjectService.getProject(dsl, s.boss, s.projectId)
        ProjectService.updateProject(s.boss, s.projectId, current.copy(name = "Přejmenováno", contractor = "Jiný zhotovitel", subcontractors = null, authorSupervisionName = "Někdo jiný"))
        dsl.update(PROJECT_MEMBERS).set(PROJECT_MEMBERS.SCOPE, "Přepsáno").where(PROJECT_MEMBERS.ROLE.eq(cz.stavebni.denik.jooq.enums.Role.INSPECTOR)).execute()
        dsl.update(cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS).set(cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS.REVOKEDAT, java.time.OffsetDateTime.now()).execute()

        val data = dataOf(report)

        assertEquals("Bytový dům Zelená", data.text("projectName"), "the page names the project as it was")
        val rows = data.rows("projectInfo")
        assertEquals("Zhotovitel s.r.o.", rows["Zhotovitel"])
        assertEquals("Ing. arch. Petr Dozor, autorizace ČKA 123", rows["Autorský dozor"])
        assertEquals("Jan Stavbyvedoucí, ČKAIT 0012345", rows["Stavbyvedoucí"])
        assertEquals("SZ/1 ze dne 15. 3. 2026", rows["Povolení"])
        assertEquals("Elektro s.r.o.", data.text("subcontractors"))
        assertEquals("Smlouva o dílo", data.text("supportingDocuments"))
        assertEquals(listOf("Jan Stavbyvedoucí", "Marie Zástupce"), data.names("managers"))
        assertEquals("Zástupce, objekty SO 02 a SO 03", data.getValue("managers").jsonArray[1].jsonObject.text("scope"))
        assertEquals("0099999", data.getValue("managers").jsonArray[1].jsonObject.text("ckait"))
        assertTrue(data.getValue("managers").jsonArray[0].jsonObject.getValue("siteManager").jsonPrimitive.boolean)
        assertFalse(data.getValue("managers").jsonArray[1].jsonObject.getValue("siteManager").jsonPrimitive.boolean)
        assertEquals(listOf("Ing. Karel Dozor"), data.names("supervisors"))
        assertEquals("Technický dozor stavebníka", data.getValue("supervisors").jsonArray[0].jsonObject.text("scope"), "the scope as it was")
        assertEquals(listOf("Eva Koordinátorka"), data.names("authorizedPersons"), "revoked since, but active on the day of signing")
        assertEquals("Koordinátor BOZP", data.getValue("authorizedPersons").jsonArray[0].jsonObject.text("function"))
        assertEquals("BOZP s.r.o.", data.getValue("authorizedPersons").jsonArray[0].jsonObject.text("company"))
    }

    @Test
    fun `the note says that part A is the one of the day of signing and part of the signature, and the hash of it is given`() = runBlocking<Unit> {
        val s = site()
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)
        val stored = dsl.select(DAILY_REPORTS.PARTASNAPSHOT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchSingle().value1()!!

        val data = dataOf(report)

        val note = data.text("projectInfoNote")
        assertTrue(note.startsWith("Údaje o stavbě platné ke dni podpisu "), note)
        assertTrue(note.contains("jsou součástí podpisu záznamu"), note)
        assertFalse(note.contains("nejsou součástí"), note)
        assertFalse(note.contains("Po podpisu tohoto záznamu byly změněny"), "part A is frozen, so there is nothing to say about changes: $note")
        assertEquals(PartASnapshot.sha256(stored), data.text("partASha256"))
        assertEquals(3, data.getValue("signatureFormat").jsonPrimitive.int)
    }

    @Test
    fun `the signer is the stored name and number, not those of the account`() = runBlocking<Unit> {
        val s = site(bossName = "Ing. Jan Stavbyvedoucí")
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)
        dsl.update(USERS).set(USERS.DISPLAYNAME, "Změněné Jméno").set(USERS.CKAITNUMBER, "7777777").where(USERS.ID.eq(s.boss.id)).execute()

        val data = dataOf(report)

        assertEquals("Ing. Jan Stavbyvedoucí, ČKAIT 0012345", data.text("signedBy"))
        // The site manager of part A is the one of the snapshot as well, and so is the author of the entry: its name is stored when the
        // entry is made (backlog B9), not read from the account.
        assertEquals("Ing. Jan Stavbyvedoucí, ČKAIT 0012345", data.rows("projectInfo")["Stavbyvedoucí"])
        assertEquals("Ing. Jan Stavbyvedoucí", data.text("author"))
    }

    @Test
    fun `an enormous signer is cut in the signature block, as before`() = runBlocking<Unit> {
        val s = site(bossName = "Jan Novák ".repeat(400))
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)

        val signedBy = dataOf(report).text("signedBy")

        assertTrue(signedBy.contains("…"), signedBy.take(200))
        assertTrue(signedBy.length < 300, "${signedBy.length}")
    }

    // --- a draft and the older formats ------------------------------------------------------------------

    @Test
    fun `a draft is given part A as it stands now, with the note it always had and the same rows`() = runBlocking<Unit> {
        val s = site()
        withPersons(s)
        val report = entry(s)

        val data = dataOf(report)

        val note = data.text("projectInfoNote")
        assertTrue(note.startsWith("Údaje o stavbě platné ke dni "), note)
        assertFalse(note.contains("podpisu"), "a draft has no signature: $note")
        assertEquals("Ing. arch. Petr Dozor, autorizace ČKA 123", data.rows("projectInfo")["Autorský dozor"])
        assertEquals(listOf("Jan Stavbyvedoucí", "Marie Zástupce"), data.names("managers"))
        assertEquals(listOf("Ing. Karel Dozor"), data.names("supervisors"))
        assertEquals(listOf("Eva Koordinátorka"), data.names("authorizedPersons"))
        assertEquals("", data.text("partASha256"))
        assertTrue(data.getValue("signatureFormat") is JsonNull)

        // It is read when the PDF is made: a change shows at once.
        val current = ProjectService.getProject(dsl, s.boss, s.projectId)
        ProjectService.updateProject(s.boss, s.projectId, current.copy(contractor = "Jiný zhotovitel"))
        assertEquals("Jiný zhotovitel", dataOf(report).rows("projectInfo")["Zhotovitel"])
    }

    @Test
    fun `an entry of format 2 is read as it was, with part A as it stands now, the signer from the account and the old note`() = runBlocking<Unit> {
        GoldenFixture.insertSignedEntry(dsl, signatureHash = "9".repeat(64), signatureFormat = 2)
        dsl.update(USERS).set(USERS.DISPLAYNAME, "Přejmenovaný Podepisující").where(USERS.ID.eq(GoldenFixture.signerId)).execute()

        val data = dataOf(GoldenFixture.entryId)

        assertEquals("Přejmenovaný Podepisující, ČKAIT 0012345", data.text("signedBy"))
        assertTrue(data.text("projectInfoNote").contains("(nejsou součástí podpisu záznamu)"), data.text("projectInfoNote"))
        assertEquals("", data.text("partASha256"))
        assertEquals(2, data.getValue("signatureFormat").jsonPrimitive.int)
        assertEquals("Golden", data.text("projectName"))
    }

    // --- a signature that lacks what it needs --------------------------------------------------------------

    @Test
    fun `a format 3 entry without its snapshot says that it cannot be verified, and does not print the project as if it were the signed one`() = runBlocking<Unit> {
        val s = site()
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)
        dsl.withoutConstraint("daily_reports_signature_format_3_check", table = "daily_reports") {
            dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
            try {
                dsl.execute("""update daily_reports set "partASnapshot" = null where id = ?""", report)
            } finally {
                dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
            }
        }

        val data = dataOf(report)

        assertTrue(data.text("projectInfoNote").contains("nelze ověřit"), data.text("projectInfoNote"))
        assertEquals("", data.text("partASha256"))
        assertTrue(data.getValue("managers").jsonArray.isEmpty() && data.getValue("authorizedPersons").jsonArray.isEmpty())
        assertTrue(data.getValue("projectInfo").jsonArray.isEmpty(), "none of the project's present data is printed as if it were what was signed")
        assertTrue(data.getValue("partAMissing").jsonPrimitive.boolean)
    }

    @Test
    fun `a format 3 entry without its signer says that it cannot be verified`() = runBlocking<Unit> {
        val s = site()
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)
        dsl.withoutConstraint("daily_reports_signature_format_3_check", table = "daily_reports") {
            dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
            try {
                dsl.execute("""update daily_reports set "signerName" = null where id = ?""", report)
            } finally {
                dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
            }
        }

        val signedBy = dataOf(report).text("signedBy")

        assertTrue(signedBy.contains("nelze ověřit"), signedBy)
        assertFalse(signedBy.contains("Jan Stavbyvedoucí"), "the account is not read in place of what was not stored: $signedBy")
    }

    @Test
    fun `the people of part A are data, never part of the template`() = runBlocking<Unit> {
        val s = site(bossName = "#panic(\"X\") *Jan*")
        val intern = createTestUser(nickname = "dozor", displayName = "#read(\"/etc/passwd\")", role = Role.INSPECTOR)
        ProjectMemberService.addMember(s.boss, s.projectId, AddMemberRequest(intern.id.toString(), "INSPECTOR", "= nadpis\n#include \"main.typ\""))
        AuthorizedPersonService.create(s.boss, s.projectId, CreateAuthorizedPersonRequest("\$ x \$", "#panic()", "*tučně*"))
        val report = entry(s)
        DailyReportService.signReport(s.boss, report)
        var typst = ""
        PdfExportService.compiler = TypstCompiler { dir, typstFile, pdfFile ->
            typst = typstFile.readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }

        PdfExportService.generateReportPdf(dsl, report)

        assertEquals(PdfExportService.template, typst)
        assertFalse(typst.contains("panic") || typst.contains("etc/passwd"))
    }
}
