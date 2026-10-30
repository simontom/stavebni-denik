package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.ADDENDA
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.REMARKS
import cz.stavebni.denik.jooq.tables.references.REPORT_ACKNOWLEDGEMENTS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.UUID
import javax.imageio.ImageIO

/**
 * The name and the ČKAIT number of the author of a record are stored **when the record is made** (backlog B9): the addenda, the
 * entries of other parties, the acknowledgements, the entry itself (its author) and the photos (their uploader). Renaming the user,
 * or correcting or clearing their number, afterwards changes none of them: what the page and the PDF print is what the record
 * stored, the audit row of the write holds the same values, and the database refuses to change them.
 */
class FrozenAuthorsTest : BaseIntegrationTest() {

    private class Site(
        val projectId: UUID,
        val boss: SessionUser,
        val worker: SessionUser,
        /** Technical supervision with a ČKAIT number. */
        val inspector: SessionUser,
        /** The client: no number. */
        val investor: SessionUser,
    )

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

    private suspend fun draft(s: Site, author: SessionUser = s.boss, day: String = "2026-09-28"): UUID =
        UUID.fromString(DailyReportService.createReport(author, s.projectId, day, workDescription = "Betonáž").id)

    private suspend fun signedEntry(s: Site, day: String = "2026-09-28"): UUID =
        draft(s, s.boss, day).also { signUnchecked(s.boss, it) }

    /** What happens to people afterwards: renamed, their number corrected or cleared. */
    private fun afterwards(user: SessionUser, name: String = "Přejmenovaný ${user.displayName}", ckait: String? = null) {
        dsl.update(USERS).set(USERS.DISPLAYNAME, name).set(USERS.CKAITNUMBER, ckait).where(USERS.ID.eq(user.id)).execute()
    }

    /** The `after` of the newest audit row of [action]. */
    private fun auditAfter(action: String): JsonObject =
        dsl.select(AUDIT_LOG.PAYLOAD_TEXT).from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.desc()).limit(1)
            .fetchSingle().auditPayload().getValue("after").jsonObject

    /** A value of an audit snapshot; a number that the person did not have is left out of the row, like the scope of a member. */
    private fun JsonObject.text(key: String): String? = get(key)?.takeUnless { it is JsonNull }?.jsonPrimitive?.content

    // --- the addenda ------------------------------------------------------------------------------------

    @Test
    fun `an addendum keeps the name and the number its author had, whatever happens to the account afterwards`() = runBlocking<Unit> {
        val s = site()
        val report = signedEntry(s)
        val byBoss = AddendumService.create(s.boss, report, CreateAddendumRequest("Oprava množství betonu"))
        val byWorker = AddendumService.create(s.worker, report, CreateAddendumRequest("Doplnění: dovezen písek"))

        afterwards(s.boss, name = "Jan Přejmenovaný", ckait = "7777777")
        afterwards(s.worker, name = "Pavel Přejmenovaný")

        val stored = dsl.selectFrom(ADDENDA).orderBy(ADDENDA.CREATEDAT.asc(), ADDENDA.ID.asc()).fetch()
        assertEquals(listOf("Ing. Jan Stavbyvedoucí", "Pavel Dělník"), stored.map { it.authorname })
        assertEquals(listOf("0012345", null), stored.map { it.authorckaitnumber }, "a worker has no number; none is stored")
        // The page shows what was stored, so it cannot disagree with the PDF.
        assertEquals(listOf("Ing. Jan Stavbyvedoucí", "Pavel Dělník"), AddendumService.list(dsl, s.boss, report).map { it.authorName })
        assertEquals("Ing. Jan Stavbyvedoucí", byBoss.authorName)
        assertEquals("Pavel Dělník", byWorker.authorName)
        // The audit row of the write holds the same values.
        val after = auditAfter("report.addendum.add")
        assertEquals("Pavel Dělník", after.text("authorName"))
        assertNull(after.text("authorCkaitNumber"))
        val bossRow = dsl.select(AUDIT_LOG.PAYLOAD_TEXT).from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.addendum.add")).orderBy(AUDIT_LOG.ID.asc()).fetch()
            .first().auditPayload().getValue("after").jsonObject
        assertEquals("Ing. Jan Stavbyvedoucí", bossRow.text("authorName"))
        assertEquals("0012345", bossRow.text("authorCkaitNumber"))
    }

    // --- the entries of other parties --------------------------------------------------------------------

    @Test
    fun `an entry of another party keeps the name and the number of who wrote it, and of the manager who recorded it for an outside party`() = runBlocking<Unit> {
        val s = site()
        val report = signedEntry(s)
        RemarkService.create(s.inspector, report, CreateRemarkRequest(text = "Bez závad."))
        RemarkService.create(s.investor, report, CreateRemarkRequest(text = "Beru na vědomí."))
        RemarkService.create(s.boss, report, CreateRemarkRequest(text = "Kontrola stavebního úřadu.", externalAuthor = "Stavební úřad"))

        afterwards(s.inspector, ckait = null)
        afterwards(s.investor)
        afterwards(s.boss, name = "Jan Přejmenovaný", ckait = "7777777")

        val stored = dsl.selectFrom(REMARKS).orderBy(REMARKS.CREATEDAT.asc(), REMARKS.ID.asc()).fetch()
        assertEquals(listOf("Ing. Karel Dozor", "Marie Stavebníková", "Ing. Jan Stavbyvedoucí"), stored.map { it.authorname })
        assertEquals(listOf("0077777", null, "0012345"), stored.map { it.authorckaitnumber }, "the client has no number: none is stored")
        assertEquals(listOf("Ing. Karel Dozor", "Marie Stavebníková", "Ing. Jan Stavbyvedoucí"), RemarkService.list(dsl, s.boss, report).map { it.authorName })
        // Each audit row holds what its record stored.
        val rows = dsl.select(AUDIT_LOG.PAYLOAD_TEXT).from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.remark.add")).orderBy(AUDIT_LOG.ID.asc()).fetch()
            .map { it.auditPayload().getValue("after").jsonObject }
        assertEquals(listOf("Ing. Karel Dozor", "Marie Stavebníková", "Ing. Jan Stavbyvedoucí"), rows.map { it.text("authorName") })
        assertEquals(listOf("0077777", null, "0012345"), rows.map { it.text("authorCkaitNumber") })
    }

    // --- the acknowledgements ----------------------------------------------------------------------------

    @Test
    fun `an acknowledgement keeps the name and the number of who took note`() = runBlocking<Unit> {
        val s = site()
        val report = signedEntry(s)
        DailyReportService.acknowledgeReport(s.inspector, report)
        DailyReportService.acknowledgeReport(s.investor, report)

        afterwards(s.inspector, name = "Karel Přejmenovaný", ckait = "1111111")
        afterwards(s.investor, name = "Marie Přejmenovaná")

        val stored = dsl.selectFrom(REPORT_ACKNOWLEDGEMENTS).orderBy(REPORT_ACKNOWLEDGEMENTS.CREATEDAT.asc(), REPORT_ACKNOWLEDGEMENTS.ID.asc()).fetch()
        assertEquals(listOf("Ing. Karel Dozor", "Marie Stavebníková"), stored.map { it.username })
        assertEquals(listOf("0077777", null), stored.map { it.userckaitnumber })
        val shown = DailyReportService.getReport(s.projectId, report.toString(), s.boss)!!.acknowledgements
        assertEquals(listOf("Ing. Karel Dozor", "Marie Stavebníková"), shown.map { it.name })
        val rows = dsl.select(AUDIT_LOG.PAYLOAD_TEXT).from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.acknowledge")).orderBy(AUDIT_LOG.ID.asc()).fetch()
            .map { it.auditPayload().getValue("after").jsonObject }
        assertEquals(listOf("Ing. Karel Dozor", "Marie Stavebníková"), rows.map { it.text("userName") })
        assertEquals(listOf("0077777", null), rows.map { it.text("userCkaitNumber") })
    }

    // --- the author of the entry and the uploader of a photo ---------------------------------------------

    @Test
    fun `the author of an entry is the name stored when the entry was made, also after a save by somebody else`() = runBlocking<Unit> {
        val s = site()
        val report = draft(s, s.worker)
        afterwards(s.worker, name = "Pavel Přejmenovaný")
        // The manager corrects the draft: the author is still who made it, by the name it had then.
        DailyReportService.saveReport(s.boss, s.projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Betonáž stropu"))

        assertEquals("Pavel Dělník", dsl.select(DAILY_REPORTS.AUTHORNAME).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchSingle().value1())
        assertEquals("Pavel Dělník", DailyReportService.getReport(s.projectId, report.toString(), s.boss)!!.authorName)
        assertEquals("Pavel Dělník", DailyReportService.getReports(s.projectId, user = s.boss).reports.single().authorName)
        assertEquals("Pavel Dělník", auditAfter("report.update").text("authorName"))
        signUnchecked(s.boss, report)
        assertEquals("Pavel Dělník", DailyReportService.getReport(s.projectId, report.toString(), s.boss)!!.authorName, "and after signing")
    }

    @Test
    fun `the audit row of the creation of an entry holds the name of its author`() = runBlocking<Unit> {
        val s = site()
        draft(s, s.worker)

        assertEquals("Pavel Dělník", auditAfter("report.create").text("authorName"))
    }

    @Test
    fun `a photo keeps the name of who uploaded it`() = runBlocking<Unit> {
        val s = site()
        val report = draft(s, s.worker)
        val photo = PhotoService.uploadPhoto(s.worker, report, jpeg(), "image/jpeg", "a.jpg")

        afterwards(s.worker, name = "Pavel Přejmenovaný")

        assertEquals("Pavel Dělník", dsl.select(PHOTOS.UPLOADEDBYNAME).from(PHOTOS).where(PHOTOS.ID.eq(photo.id)).fetchSingle().value1())
        assertEquals("Pavel Dělník", auditAfter("photo.upload").text("uploadedByName"))
    }

    // --- the database ------------------------------------------------------------------------------------

    @Test
    fun `the database refuses to change the stored names and numbers, in every table that holds them`() = runBlocking<Unit> {
        val s = site()
        val report = signedEntry(s)
        AddendumService.create(s.boss, report, CreateAddendumRequest("Oprava"))
        RemarkService.create(s.inspector, report, CreateRemarkRequest(text = "Bez závad."))
        DailyReportService.acknowledgeReport(s.inspector, report)

        for ((table, column) in listOf("addenda" to "authorName", "addenda" to "authorCkaitNumber", "remarks" to "authorName", "remarks" to "authorCkaitNumber",
            "report_acknowledgements" to "userName", "report_acknowledgements" to "userCkaitNumber")) {
            val e = assertThrows<DataAccessException>("$table.$column") { dsl.execute("""update "$table" set "$column" = 'Jiné'""") }
            assertTrue(e.message!!.contains("cannot be changed or deleted"), "$table.$column: ${e.message}")
        }
        // The stored values are as they were.
        assertEquals("Ing. Jan Stavbyvedoucí", dsl.select(ADDENDA.AUTHORNAME).from(ADDENDA).fetchSingle().value1())
        assertEquals("0077777", dsl.select(REMARKS.AUTHORCKAITNUMBER).from(REMARKS).fetchSingle().value1())
    }

    @Test
    fun `the author of an entry cannot be renamed in the database, while the entry is a draft and after it is signed`() = runBlocking<Unit> {
        val s = site()
        val draft = draft(s, s.worker, "2026-09-28")
        val signed = signedEntry(s, "2026-09-29")

        val onDraft = assertThrows<DataAccessException> { dsl.execute("""update daily_reports set "authorName" = 'Jiné' where id = ?""", draft) }
        assertTrue(onDraft.message!!.contains("author"), onDraft.message)
        val onSigned = assertThrows<DataAccessException> { dsl.execute("""update daily_reports set "authorName" = 'Jiné' where id = ?""", signed) }
        assertTrue(onSigned.message!!.contains("signed"), onSigned.message)
        // An ordinary change of a draft is still allowed, so the refusal above is about the name.
        assertEquals(1, dsl.execute("""update daily_reports set "workDescription" = 'Jiný popis' where id = ?""", draft))
        assertEquals("Pavel Dělník", dsl.select(DAILY_REPORTS.AUTHORNAME).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(draft)).fetchSingle().value1())
    }

    @Test
    fun `the uploader of a photo cannot be renamed in the database, on a draft or on a signed entry`() = runBlocking<Unit> {
        val s = site()
        val draft = draft(s, s.worker, "2026-09-28")
        val onDraft = PhotoService.uploadPhoto(s.worker, draft, jpeg(), "image/jpeg", "a.jpg")
        val signedReport = draft(s, s.boss, "2026-09-29")
        val onSigned = PhotoService.uploadPhoto(s.worker, signedReport, jpeg(), "image/jpeg", "b.jpg")
        signUnchecked(s.boss, signedReport)

        val first = assertThrows<DataAccessException> { dsl.execute("""update photos set "uploadedByName" = 'Jiné' where id = ?""", onDraft.id) }
        assertTrue(first.message!!.contains("uploader"), first.message)
        val second = assertThrows<DataAccessException> { dsl.execute("""update photos set "uploadedByName" = 'Jiné' where id = ?""", onSigned.id) }
        assertTrue(second.message!!.contains("signed daily report"), second.message)
        // A photo of a draft can still be removed: the refusal is about the name.
        assertEquals(1, dsl.execute("""update photos set "deletedAt" = now() where id = ?""", onDraft.id))
    }

    @Test
    fun `a record without a name, or with a blank one or a blank number, cannot be stored`() = runBlocking<Unit> {
        val s = site()
        val report = signedEntry(s)
        val insertAddendum = { name: String?, ckait: String? ->
            dsl.execute(
                """insert into addenda ("reportId", "authorId", "authorName", "authorCkaitNumber", text) values (?, ?, ?, ?, 'Text')""",
                report, s.boss.id, name, ckait,
            )
        }
        // The same insert with a name and a number is accepted: what is refused below is refused for the name or the number.
        assertEquals(1, insertAddendum("Ing. Jan Stavbyvedoucí", "0012345"))
        assertEquals(1, insertAddendum("Pavel Dělník", null), "a number is optional")

        assertThrows<DataAccessException>("no name") { insertAddendum(null, null) }
        assertEquals("addenda_authorName_check", assertThrows<DataAccessException>("blank name") { insertAddendum("  ", null) }.constraint())
        assertEquals("addenda_authorCkaitNumber_check", assertThrows<DataAccessException>("blank number") { insertAddendum("Pavel Dělník", "  ") }.constraint())
    }

    private fun DataAccessException.constraint(): String? = Regex("""constraint "([^"]+)"""").find(message.orEmpty())?.groupValues?.get(1)
}
