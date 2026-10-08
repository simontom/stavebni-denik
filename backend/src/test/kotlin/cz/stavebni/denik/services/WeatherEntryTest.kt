package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.module
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jooq.JSONB
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File
import java.util.UUID

/** The weather of a day is entered by hand (decision D12): validated, stored, shown, and written readably to the PDF. */
class WeatherEntryTest : BaseIntegrationTest() {

    private suspend fun project(owner: SessionUser): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = "Weather Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private fun stored(projectId: UUID) = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.PROJECTID.eq(projectId)).fetchOne()!!

    private suspend fun ApplicationTestBuilder.save(token: String, projectId: UUID, body: String): HttpResponse =
        client.post("/api/projects/$projectId/reports/2026-09-28") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    // --- the model ------------------------------------------------------------------------------

    @Test
    fun `the weather reads as Czech text`() {
        assertEquals("zataženo, 8,5 až 15 °C", WeatherData(8.5, 15.0, "zataženo").describe())
        assertEquals("jasno", WeatherData(condition = "jasno").describe())
        assertEquals("min. -3 °C", WeatherData(tempMin = -3.0).describe())
        assertEquals("max. 21,25 °C", WeatherData(tempMax = 21.25).describe())
        assertEquals("déšť, 10 až 10 °C", WeatherData(10.0, 10.0, " déšť ").describe())
        assertEquals("", WeatherData().describe())
    }

    @Test
    fun `an entry without any value is not stated, and implausible values are refused`() {
        assertNull(WeatherData().validated())
        assertNull(WeatherData(condition = "   ").validated())
        assertEquals(WeatherData(null, null, "mlha"), WeatherData(condition = "  mlha ").validated())

        assertThrows<IllegalArgumentException> { WeatherData(tempMax = 80.0).validated() }
        assertThrows<IllegalArgumentException> { WeatherData(tempMin = -61.0).validated() }
        assertThrows<IllegalArgumentException> { WeatherData(tempMin = 12.0, tempMax = 5.0).validated() }
        assertThrows<IllegalArgumentException> { WeatherData(tempMin = Double.NaN).validated() }
        assertThrows<IllegalArgumentException> { WeatherData(condition = "x".repeat(WeatherData.MAX_CONDITION_CHARS + 1)).validated() }
    }

    // --- the API --------------------------------------------------------------------------------

    @Test
    fun `weather entered with an entry is returned with it`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)

        val saved = save(token, projectId, """{"workDescription":"Betonáž","weather":{"condition":"zataženo","tempMin":8.5,"tempMax":15}}""")

        assertEquals(HttpStatusCode.OK, saved.status, saved.bodyAsText())
        val weather = Json.parseToJsonElement(saved.bodyAsText()).jsonObject["weather"]!!.jsonObject
        assertEquals("zataženo", weather["condition"]!!.jsonPrimitive.content)
        assertEquals(8.5, weather["tempMin"]!!.jsonPrimitive.content.toDouble())

        val read = client.get("/api/projects/$projectId/reports/2026-09-28") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertTrue(read.bodyAsText().contains("\"condition\":\"zataženo\""), read.bodyAsText())
    }

    @Test
    fun `a save that does not mention the weather keeps it, an empty one clears it`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)
        save(token, projectId, """{"workDescription":"Betonáž","weather":{"condition":"jasno","tempMax":20}}""")

        val kept = save(token, projectId, """{"workDescription":"Betonáž stropu"}""")
        assertEquals(HttpStatusCode.OK, kept.status, kept.bodyAsText())
        assertTrue(kept.bodyAsText().contains("\"condition\":\"jasno\""), "not mentioned keeps the weather: ${kept.bodyAsText()}")

        val cleared = save(token, projectId, """{"weather":{}}""")
        assertEquals(HttpStatusCode.OK, cleared.status, cleared.bodyAsText())
        assertNull(stored(projectId).weather, "an empty weather is stored as no weather")
        assertTrue(cleared.bodyAsText().contains("\"weather\":null"), cleared.bodyAsText())
    }

    @Test
    fun `implausible weather is a 400 and changes nothing`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val projectId = project(boss)
        save(token, projectId, """{"workDescription":"Betonáž","weather":{"condition":"jasno"}}""")

        for (body in listOf(
            """{"weather":{"tempMax":99}}""",
            """{"weather":{"tempMin":10,"tempMax":2}}""",
            """{"weather":{"condition":"${"x".repeat(300)}"}}""",
            """{"weather":{"tempMin":"warm"}}""",
        )) {
            val response = save(token, projectId, body)
            assertEquals(HttpStatusCode.BadRequest, response.status, "$body: ${response.bodyAsText()}")
        }
        assertTrue(stored(projectId).weather!!.data().contains("jasno"))
    }

    @Test
    fun `the legacy placeholder in the database counts as not stated`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28")
        dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.WEATHER, JSONB.valueOf("{}")).where(DAILY_REPORTS.ID.eq(UUID.fromString(report.id))).execute()

        val read = DailyReportService.getReport(projectId, "2026-09-28")

        assertNull(read!!.weather)
    }

    // --- audit and PDF --------------------------------------------------------------------------

    @Test
    fun `the audit snapshot holds the weather as text, without decimals`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        DailyReportService.createReport(boss, projectId, "2026-09-28", weather = WeatherData(8.5, 15.0, "zataženo"))

        val snapshot = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.create")).fetchOne()!!.get(AUDIT_LOG.AFTER)!!.data()
        val after = Json.parseToJsonElement(snapshot).jsonObject
        assertEquals("zataženo, 8,5 až 15 °C", after["weather"]!!.jsonPrimitive.content)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `the PDF is given readable weather text, not JSON`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28", weather = WeatherData(8.5, 15.0, "zataženo"))
        val plain = DailyReportService.createReport(boss, projectId, "2026-09-29")
        var captured = ""
        val original = PdfExportService.compiler
        PdfExportService.compiler = object : TypstCompiler {
            override fun compile(workDir: File, typstFile: File, pdfFile: File) {
                captured = File(workDir, "data.json").readText()
                pdfFile.writeBytes(MINIMAL_PDF)
            }
        }
        try {
            PdfExportService.generateReportPdf(dsl, UUID.fromString(report.id))
            assertEquals("zataženo, 8,5 až 15 °C", Json.parseToJsonElement(captured).jsonObject["weather"]!!.jsonPrimitive.content)

            PdfExportService.generateReportPdf(dsl, UUID.fromString(plain.id))
            assertEquals("Neuvedeno", Json.parseToJsonElement(captured).jsonObject["weather"]!!.jsonPrimitive.content)
        } finally {
            PdfExportService.compiler = original
        }
    }
}
