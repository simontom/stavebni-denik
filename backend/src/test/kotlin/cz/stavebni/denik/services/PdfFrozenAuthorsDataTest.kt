package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import javax.imageio.ImageIO

/**
 * What the PDF of an entry is given about **who wrote** each record (backlog B9): the author of the entry, the uploader of each
 * photo, and the author of each addendum, entry of another party and acknowledgement, with their ČKAIT number where they had one.
 * All of it is read from what the record stored when it was made, never from the account as it is now.
 */
class PdfFrozenAuthorsDataTest : BaseIntegrationTest() {

    private class Site(val projectId: UUID, val boss: SessionUser, val worker: SessionUser, val inspector: SessionUser, val investor: SessionUser)

    private suspend fun site(): Site {
        val boss = createTestUser(nickname = "boss", displayName = "Ing. Jan Stavbyvedoucí", role = Role.BOSS, ckaitNumber = "0012345")
        val worker = createTestUser(nickname = "worker", displayName = "Pavel Dělník", role = Role.WORKER)
        val inspector = createTestUser(nickname = "dozor", displayName = "Ing. Karel Dozor", role = Role.INSPECTOR, ckaitNumber = "0077777")
        val investor = createTestUser(nickname = "investor", displayName = "Marie Stavebníková", role = Role.INVESTOR)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Stavba", address = "Ulice 1", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        for (member in listOf(worker, inspector, investor)) addMember(projectId, member)
        return Site(projectId, boss, worker, inspector, investor)
    }

    private fun jpeg(): ByteArray {
        val out = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(200, 150, BufferedImage.TYPE_INT_RGB), "jpeg", out)
        return out.toByteArray()
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

    private fun JsonObject.text(key: String): String = getValue(key).jsonPrimitive.content

    private fun JsonObject.list(key: String): List<JsonObject> = getValue(key).jsonArray.map { it.jsonObject }

    private fun renameEveryone() {
        dsl.update(USERS).set(USERS.DISPLAYNAME, "Přejmenovaný").set(USERS.CKAITNUMBER, "9999999").execute()
    }

    @Test
    fun `the author of the entry and the uploader of a photo are the names stored when they were made`() = runBlocking<Unit> {
        val s = site()
        val report = UUID.fromString(DailyReportService.createReport(s.worker, s.projectId, "2026-09-28", workDescription = "Betonáž").id)
        PhotoService.uploadPhoto(s.boss, report, jpeg(), "image/jpeg", "a.jpg")
        renameEveryone()

        val draft = dataOf(report)
        assertEquals("Pavel Dělník", draft.text("author"))
        assertEquals("Ing. Jan Stavbyvedoucí", draft.list("photos").single().text("uploadedBy"))

        signUnchecked(s.boss, report)
        val signed = dataOf(report)
        assertEquals("Pavel Dělník", signed.text("author"))
        assertEquals("Ing. Jan Stavbyvedoucí", signed.list("photos").single().text("uploadedBy"))
    }

    @Test
    fun `an addendum is printed with the name and the ČKAIT number its author had, and a person without a number has none`() = runBlocking<Unit> {
        val s = site()
        val report = UUID.fromString(DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(s.boss, report)
        AddendumService.create(s.boss, report, CreateAddendumRequest("Oprava množství"))
        AddendumService.create(s.worker, report, CreateAddendumRequest("Doplnění"))
        renameEveryone()

        val addenda = dataOf(report).list("addenda")

        assertEquals(listOf("Ing. Jan Stavbyvedoucí, ČKAIT 0012345", "Pavel Dělník"), addenda.map { it.text("author") })
    }

    @Test
    fun `an entry of another party is printed with its author's number, and an entry recorded for an outside party with the manager who recorded it`() = runBlocking<Unit> {
        val s = site()
        val report = UUID.fromString(DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(s.boss, report)
        RemarkService.create(s.inspector, report, CreateRemarkRequest(text = "Bez závad."))
        RemarkService.create(s.investor, report, CreateRemarkRequest(text = "Beru na vědomí."))
        RemarkService.create(s.boss, report, CreateRemarkRequest(text = "Kontrola.", externalAuthor = "Stavební úřad"))
        renameEveryone()

        val remarks = dataOf(report).list("remarks")

        assertEquals(
            listOf("Ing. Karel Dozor, ČKAIT 0077777", "Marie Stavebníková", "Ing. Jan Stavbyvedoucí, ČKAIT 0012345"),
            remarks.map { it.text("author") },
        )
        assertEquals(listOf("", "", "Stavební úřad"), remarks.map { it.text("onBehalfOf") })
    }

    @Test
    fun `an acknowledgement is printed with the name and the number of who took note, and the role`() = runBlocking<Unit> {
        val s = site()
        val report = UUID.fromString(DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Betonáž").id)
        signUnchecked(s.boss, report)
        DailyReportService.acknowledgeReport(s.inspector, report)
        DailyReportService.acknowledgeReport(s.investor, report)
        renameEveryone()

        val acknowledgements = dataOf(report).list("acknowledgements")

        assertEquals(
            listOf("Ing. Karel Dozor, ČKAIT 0077777 (dozor)", "Marie Stavebníková (stavebník)"),
            acknowledgements.map { it.text("who") },
        )
    }
}
