package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/**
 * What the entry page needs to show an entry as a document (backlog B4): who wrote it, who signed it with which number and when,
 * and the weather as the words that are signed, all in the DTO that the page and the list already load, so that nothing has to be
 * fetched by a click ("Ověřit podpis" still verifies, it is no longer the only way to see the signer).
 */
class ReportDocumentDtoTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val worker: SessionUser, val projectId: UUID)

    private suspend fun site(): Site {
        val boss = createTestUser(nickname = "boss", displayName = "Jan Stavbyvedoucí", role = Role.BOSS, ckaitNumber = "0012345")
        val worker = createTestUser(nickname = "worker", displayName = "Karel Pracovník", role = Role.WORKER)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Bytový dům", address = "Ulice 1", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        addMember(projectId, worker, Role.WORKER)
        return Site(boss, worker, projectId)
    }

    private suspend fun save(s: Site, author: SessionUser, day: String, weather: WeatherData? = null): DailyReportDto =
        DailyReportService.saveReport(
            author, s.projectId, day,
            DailyReportService.ReportInput(workDescription = "Betonáž", weather = weather, lateEntryReason = "pozdě"),
        )

    // --- the author -----------------------------------------------------------------------------------

    @Test
    fun `an entry names its author, in the list, in the single entry and in the answer of a save`() = runBlocking<Unit> {
        val s = site()
        val created = save(s, s.worker, "2026-09-28")
        assertEquals("Karel Pracovník", created.authorName, "the answer to the save that created it")

        // The manager corrects the worker's entry: the author stays the worker.
        val corrected = DailyReportService.saveReport(
            s.boss, s.projectId, "2026-09-28",
            DailyReportService.ReportInput(workDescription = "Opraveno", expectedUpdatedAt = java.time.OffsetDateTime.parse(created.updatedAt!!)),
        )
        assertEquals("Karel Pracovník", corrected.authorName, "the answer to a save by somebody else")

        assertEquals("Karel Pracovník", DailyReportService.getReport(s.projectId, "2026-09-28")!!.authorName)
        assertEquals("Karel Pracovník", DailyReportService.getReport(s.projectId, created.id)!!.authorName, "by id as well as by day")
        val own = save(s, s.boss, "2026-09-29")
        assertEquals(listOf("Jan Stavbyvedoucí", "Karel Pracovník"), DailyReportService.getReports(s.projectId).reports.map { it.authorName })
        assertEquals("Jan Stavbyvedoucí", own.authorName)
    }

    @Test
    fun `the author is named as the account says it now`() = runBlocking<Unit> {
        val s = site()
        val created = save(s, s.worker, "2026-09-28")

        dsl.update(USERS).set(USERS.DISPLAYNAME, "Karel Novák").where(USERS.ID.eq(s.worker.id)).execute()

        assertEquals("Karel Novák", DailyReportService.getReport(s.projectId, created.id)!!.authorName)
    }

    // --- who signed -----------------------------------------------------------------------------------

    @Test
    fun `a draft has no signer`() = runBlocking<Unit> {
        val s = site()
        val draft = save(s, s.boss, "2026-09-28")

        for (dto in listOf(draft, DailyReportService.getReport(s.projectId, draft.id)!!, DailyReportService.getReports(s.projectId).reports.single())) {
            assertNull(dto.signerName)
            assertNull(dto.signerCkaitNumber)
            assertNull(dto.signedAt)
            assertFalse(dto.signerFrozen)
            assertFalse(dto.isSigned)
        }
    }

    @Test
    fun `a signed entry says who signed it, with the number and the time, without a request for the signature check`() = runBlocking<Unit> {
        val s = site()
        val saved = save(s, s.worker, "2026-09-28")
        DailyReportService.signReport(s.boss, UUID.fromString(saved.id))

        val check = ReportSignature.check(dsl, UUID.fromString(saved.id))
        for (dto in listOf(DailyReportService.getReport(s.projectId, saved.id)!!, DailyReportService.getReports(s.projectId).reports.single())) {
            assertEquals("Jan Stavbyvedoucí", dto.signerName, "the signer, not the author")
            assertEquals("0012345", dto.signerCkaitNumber)
            assertEquals("Karel Pracovník", dto.authorName)
            assertTrue(dto.signerFrozen, "format 3 stores the signer")
            assertEquals(check.signedAt, dto.signedAt, "the time is the one the check reports")
            assertEquals(check.signedByName, dto.signerName)
            assertEquals(check.signerCkaitNumber, dto.signerCkaitNumber)
        }
    }

    @Test
    fun `a deputy who signs is the signer shown, not the site manager`() = runBlocking<Unit> {
        val s = site()
        val deputy = createTestUser(nickname = "deputy", displayName = "Marie Zástupce", role = Role.BOSS, ckaitNumber = "0099999")
        addMember(s.projectId, deputy, Role.BOSS)
        val saved = save(s, s.boss, "2026-09-28")
        DailyReportService.signReport(deputy, UUID.fromString(saved.id))

        val dto = DailyReportService.getReport(s.projectId, saved.id)!!
        assertEquals("Marie Zástupce", dto.signerName)
        assertEquals("0099999", dto.signerCkaitNumber)
    }

    @Test
    fun `the signer shown is the one stored at signing, whatever happens to the account afterwards`() = runBlocking<Unit> {
        val s = site()
        val saved = save(s, s.boss, "2026-09-28")
        DailyReportService.signReport(s.boss, UUID.fromString(saved.id))

        dsl.update(USERS).set(USERS.DISPLAYNAME, "Úplně Jiné Jméno").set(USERS.CKAITNUMBER, "7777777").where(USERS.ID.eq(s.boss.id)).execute()
        val renamed = DailyReportService.getReport(s.projectId, saved.id)!!
        assertEquals("Jan Stavbyvedoucí", renamed.signerName)
        assertEquals("0012345", renamed.signerCkaitNumber)
        assertEquals("Úplně Jiné Jméno", renamed.authorName, "the author, unlike the signer, is read from the account as it is now (backlog B9)")

        dsl.update(USERS).setNull(USERS.CKAITNUMBER).where(USERS.ID.eq(s.boss.id)).execute()
        assertEquals("0012345", DailyReportService.getReport(s.projectId, saved.id)!!.signerCkaitNumber)
    }

    @Test
    fun `an entry signed before format 3 shows the account as it is now, and says it is not stored`() = runBlocking<Unit> {
        GoldenFixture.insertSignedEntry(dsl, signatureHash = "9".repeat(64), signatureFormat = 2)

        val dto = DailyReportService.getReport(GoldenFixture.projectId, GoldenFixture.entryId.toString())!!
        assertEquals("Golden Signer", dto.signerName)
        assertEquals("0012345", dto.signerCkaitNumber)
        assertFalse(dto.signerFrozen, "formats 1 and 2 kept no copy of the signer")
        assertEquals("Golden Signer", dto.authorName)
        assertNotNull(dto.signedAt)

        dsl.update(USERS).set(USERS.DISPLAYNAME, "Golden Renamed").where(USERS.ID.eq(GoldenFixture.signerId)).execute()
        assertEquals("Golden Renamed", DailyReportService.getReport(GoldenFixture.projectId, GoldenFixture.entryId.toString())!!.signerName)
        assertEquals("Golden Renamed", DailyReportService.getReports(GoldenFixture.projectId).reports.single().signerName, "the list reads it the same way")
        assertEquals("Golden Renamed", ReportSignature.check(dsl, GoldenFixture.entryId).signedByName, "as the signature check does")
    }

    @Test
    fun `an entry of another project is not readable through this one`() = runBlocking<Unit> {
        val s = site()
        val other = ProjectService.createProject(
            s.boss,
            ProjectDto(id = "", name = "Jiný", address = "A", cadastralArea = "B", parcelNumbers = "2", builder = "C", contractor = "D", siteManagerId = s.boss.id.toString()),
        )
        val otherId = UUID.fromString(other.id)
        val saved = DailyReportService.saveReport(s.boss, otherId, "2026-09-28", DailyReportService.ReportInput(workDescription = "x", lateEntryReason = "pozdě"))
        DailyReportService.signReport(s.boss, UUID.fromString(saved.id))

        assertNull(DailyReportService.getReport(s.projectId, saved.id), "the id of another project's entry finds nothing here")
        assertEquals(emptyList<DailyReportDto>(), DailyReportService.getReports(s.projectId).reports)
    }

    // --- the weather ----------------------------------------------------------------------------------

    @Test
    fun `the weather is also given as the text the signature covers`() = runBlocking<Unit> {
        val s = site()
        val withWeather = save(s, s.boss, "2026-09-28", WeatherData(tempMin = 8.5, tempMax = 15.0, condition = "zataženo"))
        val without = save(s, s.boss, "2026-09-29")

        assertEquals("zataženo, 8,5 až 15 °C", withWeather.weatherText)
        assertEquals("zataženo, 8,5 až 15 °C", DailyReportService.getReport(s.projectId, withWeather.id)!!.weatherText)
        assertNull(without.weatherText, "nothing stated is null, not an empty text")
        assertEquals(listOf(null, "zataženo, 8,5 až 15 °C"), DailyReportService.getReports(s.projectId).reports.map { it.weatherText })
    }

    // --- who may change it ------------------------------------------------------------------------------

    private class Cast(val site: Site, val otherWorker: SessionUser, val inspector: SessionUser, val investor: SessionUser, val admin: SessionUser)

    private suspend fun cast(): Cast {
        val s = site()
        val otherWorker = createTestUser(nickname = "worker2", displayName = "Druhý Pracovník", role = Role.WORKER)
        val inspector = createTestUser(nickname = "inspector", displayName = "Dozor", role = Role.INSPECTOR)
        val investor = createTestUser(nickname = "investor", displayName = "Ivo Investor", role = Role.INVESTOR)
        val admin = createTestUser(nickname = "admin", displayName = "Správce", role = Role.WORKER, isAdmin = true)
        addMember(s.projectId, otherWorker, Role.WORKER)
        addMember(s.projectId, inspector, Role.INSPECTOR)
        addMember(s.projectId, investor, Role.INVESTOR)
        return Cast(s, otherWorker, inspector, investor, admin)
    }

    /** What [viewer] is told about the entry of [day] by the single read, by the read by id and by the list: all three must agree. */
    private suspend fun canEditSeenBy(c: Cast, viewer: SessionUser?, day: String): Boolean {
        val single = DailyReportService.getReport(c.site.projectId, day, viewer)!!
        val byId = DailyReportService.getReport(c.site.projectId, single.id, viewer)!!
        val inList = DailyReportService.getReports(c.site.projectId, user = viewer).reports.single { it.date == day }
        assertEquals(single.canEdit, byId.canEdit, "by id")
        assertEquals(single.canEdit, inList.canEdit, "in the list")
        return single.canEdit
    }

    @Test
    fun `the manager may change any unsigned entry, a worker only their own, nobody else`() = runBlocking<Unit> {
        val c = cast()
        val s = c.site
        save(s, s.worker, "2026-09-28") // the worker's
        save(s, s.boss, "2026-09-29") // the manager's

        assertTrue(canEditSeenBy(c, s.boss, "2026-09-28"), "a manager corrects the worker's entry")
        assertTrue(canEditSeenBy(c, s.boss, "2026-09-29"))
        assertTrue(canEditSeenBy(c, s.worker, "2026-09-28"), "a worker's own")
        assertFalse(canEditSeenBy(c, s.worker, "2026-09-29"), "a worker may not change the manager's entry")
        assertFalse(canEditSeenBy(c, c.otherWorker, "2026-09-28"), "nor another worker's")
        assertFalse(canEditSeenBy(c, c.inspector, "2026-09-28"))
        assertFalse(canEditSeenBy(c, c.investor, "2026-09-28"))
        assertFalse(canEditSeenBy(c, c.admin, "2026-09-28"), "an administrator who is not a member has no right to write")
        assertFalse(canEditSeenBy(c, null, "2026-09-28"), "an internal read that does not know who asks says no")
    }

    @Test
    fun `nobody may change a signed entry`() = runBlocking<Unit> {
        val c = cast()
        val s = c.site
        val saved = save(s, s.worker, "2026-09-28")
        DailyReportService.signReport(s.boss, UUID.fromString(saved.id))

        for (viewer in listOf(s.boss, s.worker, c.otherWorker, c.inspector, c.investor, c.admin)) {
            assertFalse(canEditSeenBy(c, viewer, "2026-09-28"), viewer.nickname)
        }
    }

    @Test
    fun `the answer to a save says whether the saver may go on changing the entry, by the same rule`() = runBlocking<Unit> {
        val c = cast()
        val s = c.site
        val created = save(s, s.worker, "2026-09-28")
        assertTrue(created.canEdit, "the worker who created it")

        val corrected = DailyReportService.saveReport(
            s.boss, s.projectId, "2026-09-28",
            DailyReportService.ReportInput(workDescription = "Opraveno", expectedUpdatedAt = java.time.OffsetDateTime.parse(created.updatedAt!!)),
        )
        assertTrue(corrected.canEdit, "the manager who corrected it")
    }

    @Test
    fun `the decision is the one the save makes, so what the page is told is not allowed is refused over the route`() = testApplication {
        application { module() }
        val c = runBlocking { cast() }
        val s = c.site
        val bosses = runBlocking { save(s, s.boss, "2026-09-29") }
        val workers = runBlocking { save(s, s.worker, "2026-09-28") }

        suspend fun read(user: SessionUser, day: String) =
            Json.parseToJsonElement(client.get("/api/projects/${s.projectId}/reports/$day") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }.bodyAsText()).jsonObject
        suspend fun saveAs(user: SessionUser, day: String, updatedAt: String) =
            client.post("/api/projects/${s.projectId}/reports/$day") {
                header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
                contentType(ContentType.Application.Json)
                setBody("""{"workDescription":"Změna","expectedUpdatedAt":"$updatedAt"}""")
            }

        // The worker is told they may not change the manager's entry, and the save agrees.
        assertEquals("false", read(s.worker, "2026-09-29")["canEdit"]!!.jsonPrimitive.content)
        assertEquals(HttpStatusCode.Forbidden, saveAs(s.worker, "2026-09-29", bosses.updatedAt!!).status)
        // ... and that they may change their own, and the save agrees.
        assertEquals("true", read(s.worker, "2026-09-28")["canEdit"]!!.jsonPrimitive.content)
        assertEquals(HttpStatusCode.OK, saveAs(s.worker, "2026-09-28", workers.updatedAt!!).status)
        // An investor is told no, and the save refuses.
        assertEquals("false", read(c.investor, "2026-09-28")["canEdit"]!!.jsonPrimitive.content)
        assertEquals(HttpStatusCode.Forbidden, saveAs(c.investor, "2026-09-28", workers.updatedAt!!).status)
    }

    // --- a signature that lacks its signer ---------------------------------------------------------------------

    @Test
    fun `a format 3 entry that lost its signer name or number says the signer is incomplete, and a whole one does not`() = runBlocking<Unit> {
        val s = site()
        val whole = save(s, s.boss, "2026-09-28")
        val noName = save(s, s.boss, "2026-09-29")
        val noNumber = save(s, s.boss, "2026-09-30")
        for (e in listOf(whole, noName, noNumber)) DailyReportService.signReport(s.boss, UUID.fromString(e.id))
        // The database refuses such a row; whoever owns the table can switch the constraint and the triggers off.
        dsl.withoutConstraint("daily_reports_signature_format_3_check", table = "daily_reports") {
            dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
            try {
                dsl.execute("""update daily_reports set "signerName" = null where id = ?""", UUID.fromString(noName.id))
                dsl.execute("""update daily_reports set "signerCkaitNumber" = '  ' where id = ?""", UUID.fromString(noNumber.id))
            } finally {
                dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
            }
        }

        assertFalse(DailyReportService.getReport(s.projectId, whole.id)!!.signerIncomplete)
        for (id in listOf(noName.id, noNumber.id)) {
            val one = DailyReportService.getReport(s.projectId, id)!!
            assertTrue(one.signerIncomplete, "one of the two is missing: ${one.signerName} / ${one.signerCkaitNumber}")
            assertTrue(one.isSigned)
        }
        assertEquals(listOf(false, true, true), DailyReportService.getReports(s.projectId).reports.reversed().map { it.signerIncomplete }, "the list says the same")
    }

    @Test
    fun `a draft, and an entry of format 2 that kept no copy of the signer, are not incomplete`() = runBlocking<Unit> {
        val s = site()
        assertFalse(save(s, s.boss, "2026-09-28").signerIncomplete)

        GoldenFixture.insertSignedEntry(dsl, signatureHash = "9".repeat(64), signatureFormat = 2)
        assertFalse(
            DailyReportService.getReport(GoldenFixture.projectId, GoldenFixture.entryId.toString())!!.signerIncomplete,
            "formats 1 and 2 never stored it, and say so by signerFrozen = false",
        )
    }

    // --- over the routes: who may read it ---------------------------------------------------------------

    @Test
    fun `an investor reads the signer and the author over the route, a stranger gets nothing, and a draft names no signer`() = testApplication {
        application { module() }
        val s = runBlocking { site() }
        val investor = createTestUser(nickname = "investor", displayName = "Ivo Investor", role = Role.INVESTOR)
        val stranger = createTestUser(nickname = "stranger", displayName = "Cizí Člověk", role = Role.INVESTOR)
        addMember(s.projectId, investor, Role.INVESTOR)
        val signed = runBlocking { save(s, s.worker, "2026-09-28") }
        runBlocking { DailyReportService.signReport(s.boss, UUID.fromString(signed.id)) }
        runBlocking { save(s, s.worker, "2026-09-29") }

        suspend fun get(path: String, user: SessionUser) = client.get(path) { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }

        val single = Json.parseToJsonElement(get("/api/projects/${s.projectId}/reports/2026-09-28", investor).bodyAsText()).jsonObject
        assertEquals("Jan Stavbyvedoucí", single["signerName"]!!.jsonPrimitive.content)
        assertEquals("0012345", single["signerCkaitNumber"]!!.jsonPrimitive.content)
        assertEquals("Karel Pracovník", single["authorName"]!!.jsonPrimitive.content)
        assertEquals("true", single["signerFrozen"]!!.jsonPrimitive.content)
        assertTrue(single["signedAt"]!!.jsonPrimitive.content.startsWith("20"), "the time of signing")

        val list = Json.parseToJsonElement(get("/api/projects/${s.projectId}/reports", investor).bodyAsText()).jsonArray.map { it.jsonObject }
        assertEquals(listOf("2026-09-29", "2026-09-28"), list.map { it["date"]!!.jsonPrimitive.content })
        assertTrue(list[0]["signerName"] is JsonNull, "a draft has no signer")
        assertTrue(list[0]["signerCkaitNumber"] is JsonNull)
        assertEquals("Karel Pracovník", list[0]["authorName"]!!.jsonPrimitive.content)
        assertEquals("Jan Stavbyvedoucí", list[1]["signerName"]!!.jsonPrimitive.content)

        for (path in listOf("/api/projects/${s.projectId}/reports", "/api/projects/${s.projectId}/reports/2026-09-28", "/api/reports/${signed.id}")) {
            val refused = get(path, stranger)
            assertEquals(HttpStatusCode.Forbidden, refused.status, path)
            assertFalse(refused.bodyAsText().contains("Jan Stavbyvedoucí"), "nothing of the entry reaches a stranger: $path")
        }
    }
}
