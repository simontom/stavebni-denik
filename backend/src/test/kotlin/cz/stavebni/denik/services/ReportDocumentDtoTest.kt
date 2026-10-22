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
