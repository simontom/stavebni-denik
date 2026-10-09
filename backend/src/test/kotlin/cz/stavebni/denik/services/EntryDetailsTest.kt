package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File
import java.util.UUID

/**
 * What the vyhláška asks a daily entry to say besides the day's work (příloha 12, part B): the fields of [EntryDetails] and
 * the names of the people on site. They are stored, audited, signed and printed like the rest of the entry.
 */
class EntryDetailsTest : BaseIntegrationTest() {

    private suspend fun project(owner: SessionUser): UUID =
        UUID.fromString(
            ProjectService.createProject(
                owner,
                ProjectDto(
                    id = "", name = "Náležitosti", address = "A", cadastralArea = "C", parcelNumbers = "1",
                    builder = "B", contractor = "C", siteManagerId = owner.id.toString(),
                )
            ).id
        )

    private suspend fun save(user: SessionUser, projectId: UUID, details: Map<String, String>? = null, workers: String? = null, date: String = "2026-09-28") =
        DailyReportService.saveReport(
            user, projectId, date,
            DailyReportService.ReportInput(workDescription = "Betonáž", details = details, workersByTrade = workers),
        )

    private fun record(id: String) = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(id))).fetchSingle()

    @Test
    fun `the fields are stored, returned, and only the mentioned ones change`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        val first = save(boss, projectId, details = mapOf("materials" to "Beton C25/30, 12 m3", "machinery" to "Bagr"))
        assertEquals(mapOf("materials" to "Beton C25/30, 12 m3", "machinery" to "Bagr"), first.details)

        // Mentioning one field changes that one; an empty text clears it; the others stay.
        val second = save(boss, projectId, details = mapOf("machinery" to "  ", "dustMeasures" to "Kropení"))
        assertEquals(mapOf("materials" to "Beton C25/30, 12 m3", "dustMeasures" to "Kropení"), second.details)

        // Not mentioning details at all changes none of them.
        val third = save(boss, projectId, details = null)
        assertEquals(second.details, third.details)
        assertEquals("Kropení", record(third.id).get(DAILY_REPORTS.DUSTMEASURES))
    }

    @Test
    fun `every field has its own column and order`() {
        assertEquals(
            listOf("materials", "machinery", "testsAndChecks", "safetyNotes", "dustMeasures", "accessibilityMeasures", "defects", "otherNotes"),
            EntryDetails.FIELDS.map { it.key },
        )
        assertEquals(EntryDetails.FIELDS.size, EntryDetails.FIELDS.map { it.column.name }.toSet().size)
    }

    @Test
    fun `an unknown field and a text that is too long are refused and nothing is stored`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        assertThrows<IllegalArgumentException> { save(boss, projectId, details = mapOf("password" to "x")) }
        assertThrows<IllegalArgumentException> { save(boss, projectId, details = mapOf("materials" to "x".repeat(EntryDetails.MAX_CHARS + 1))) }

        assertEquals(0, dsl.fetchCount(DAILY_REPORTS), "a refused request creates no entry")
        // The longest allowed text is accepted.
        assertEquals(EntryDetails.MAX_CHARS, save(boss, projectId, details = mapOf("materials" to "x".repeat(EntryDetails.MAX_CHARS))).details["materials"]!!.length)
    }

    @Test
    fun `the names of the people on site are kept with their trade`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        val saved = save(boss, projectId, workers = """[{"trade":"Betonáři","count":3,"names":["  Jan Novák ","Petr Svoboda"]},{"trade":"Zedníci","count":2}]""")

        val stored = Json.parseToJsonElement(saved.workersByTrade).jsonArray
        assertEquals(listOf("Jan Novák", "Petr Svoboda"), stored[0].jsonObject["names"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertFalse(stored[1].jsonObject.containsKey("names"), "a trade without names keeps the shape it always had")
    }

    @Test
    fun `more names than workers, an empty name and an enormous name are refused`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        assertThrows<IllegalArgumentException> { save(boss, projectId, workers = """[{"trade":"Zedníci","count":1,"names":["A","B"]}]""") }
        assertThrows<IllegalArgumentException> { save(boss, projectId, workers = """[{"trade":"Zedníci","count":1,"names":["  "]}]""") }
        assertThrows<IllegalArgumentException> { save(boss, projectId, workers = """[{"trade":"Zedníci","count":1,"names":["${"x".repeat(101)}"]}]""") }
    }

    @Test
    fun `the audit row of a change carries the fields`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        save(boss, projectId, details = mapOf("defects" to "Trhlina v omítce"))

        val after = dsl.select(AUDIT_LOG.AFTER).from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.create")).fetchSingle(AUDIT_LOG.AFTER)!!.data()
        assertTrue(after.contains("Trhlina v omítce"), after)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a signed entry cannot take new fields`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val saved = save(boss, projectId, details = mapOf("materials" to "Cement"))
        DailyReportService.signReport(boss, UUID.fromString(saved.id))

        assertThrows<cz.stavebni.denik.domain.ConflictException> { save(boss, projectId, details = mapOf("materials" to "Jiný")) }
        assertEquals("Cement", record(saved.id).get(DAILY_REPORTS.MATERIALSIN))
    }

    // --- what the signature covers ------------------------------------------------------------------

    private fun tamper(sql: String, vararg bindings: Any) {
        dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
        try {
            dsl.execute(sql, *bindings)
        } finally {
            dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
        }
    }

    @Test
    fun `a new signature covers the fields and the names, and says so`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val saved = save(boss, projectId, details = mapOf("materials" to "Cement"), workers = """[{"trade":"Zedníci","count":1,"names":["Jan Novák"]}]""")
        val id = UUID.fromString(saved.id)
        // The format is a property of the signature, not of the row: a draft is in format 1 until it is signed ...
        assertEquals(1.toShort(), record(saved.id).get(DAILY_REPORTS.SIGNATUREFORMAT))
        DailyReportService.signReport(boss, id)

        // ... and signing moves it to the current one, before the hash is made.
        assertEquals(2.toShort(), record(saved.id).get(DAILY_REPORTS.SIGNATUREFORMAT))
        assertEquals(true, ReportSignature.check(dsl, id).contentMatches)

        // A field changed behind the application's back breaks it ...
        tamper("""update daily_reports set "materialsIn" = 'Písek' where id = ?""", id)
        assertEquals(false, ReportSignature.check(dsl, id).contentMatches)
        tamper("""update daily_reports set "materialsIn" = 'Cement' where id = ?""", id)
        assertEquals(true, ReportSignature.check(dsl, id).contentMatches)

        // ... and so does a name.
        tamper("""update daily_reports set "workersByTrade" = '[{"trade":"Zedníci","count":1,"names":["Karel Cizí"]}]'::jsonb where id = ?""", id)
        assertEquals(false, ReportSignature.check(dsl, id).contentMatches)
    }

    @Test
    fun `an entry signed before the fields existed still verifies, in the format it was signed in`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val saved = save(boss, projectId, details = mapOf("materials" to "Cement"))
        val id = UUID.fromString(saved.id)
        DailyReportService.signReport(boss, id)

        // Make it look like an entry from before V14: format 1 and the hash that format covers.
        val signed = record(saved.id)
        signed.set(DAILY_REPORTS.SIGNATUREFORMAT, 1.toShort())
        val legacyHash = ReportSignature.hash(dsl, signed, signed.signedat!!, signed.signedbyid!!)
        tamper("""update daily_reports set "signatureFormat" = 1, "signatureHash" = ? where id = ?""", legacyHash, id)

        assertEquals(true, ReportSignature.check(dsl, id).contentMatches, "an old signature is checked against what it covered")
        assertTrue(ReportSignature.checkAll(dsl).ok)

        // What that format never covered does not break it (this is why the format is stored).
        tamper("""update daily_reports set "materialsIn" = 'Písek' where id = ?""", id)
        assertEquals(true, ReportSignature.check(dsl, id).contentMatches)
        // What it did cover still does.
        tamper("""update daily_reports set "workDescription" = 'Zfalšováno' where id = ?""", id)
        assertEquals(false, ReportSignature.check(dsl, id).contentMatches)
    }

    @Test
    fun `the database refuses a signature format that does not exist`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val saved = save(boss, projectId)

        val refused = assertThrows<org.jooq.exception.DataAccessException> {
            dsl.execute("""update daily_reports set "signatureFormat" = 3 where id = ?""", UUID.fromString(saved.id))
        }
        assertEquals("23514", refused.sqlState(), "check_violation")
        assertEquals(1.toShort(), record(saved.id).get(DAILY_REPORTS.SIGNATUREFORMAT), "a new entry starts in format 1: signing sets the format")
    }

    // --- what is printed ------------------------------------------------------------------

    @Test
    fun `typst is given the people on site and the filled fields, with the labels of the vyhláška`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val saved = save(
            boss, projectId,
            details = mapOf("dustMeasures" to "#panic(\"x\") Kropení", "materials" to "Cement"),
            workers = """[{"trade":"Zedníci","count":2,"names":["Jan Novák","Petr Svoboda"]}]""",
        )

        var data = ""
        var typst = ""
        PdfExportService.compiler = TypstCompiler { dir, typstFile, pdfFile ->
            typst = typstFile.readText()
            data = File(dir, "data.json").readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }
        PdfExportService.generateReportPdf(dsl, UUID.fromString(saved.id))

        val json = Json.parseToJsonElement(data).jsonObject
        val worker = json["workers"]!!.jsonArray.single().jsonObject
        assertEquals("Zedníci", worker["trade"]!!.jsonPrimitive.content)
        // Separated by semicolons, because a name can have a comma in it ("Ing. Jan Novák, Ph.D.").
        assertEquals("Jan Novák; Petr Svoboda", worker["names"]!!.jsonPrimitive.content)
        // In the fixed order of the fields, only those with a text; the text is data, never part of the template.
        val details = json["details"]!!.jsonArray.map { it.jsonObject["label"]!!.jsonPrimitive.content to it.jsonObject["text"]!!.jsonPrimitive.content }
        assertEquals(
            listOf(
                "Dodávky a uskladnění materiálu a zařízení" to "Cement",
                "Opatření proti prašnosti" to "#panic(\"x\") Kropení",
            ),
            details,
        )
        assertEquals(PdfExportService.template, typst, "main.typ given to typst is exactly the fixed template")
        assertFalse(typst.contains("panic"), "the text of a field never becomes part of the typst source")
    }

    // --- the rest of what the docs claim ------------------------------------------------------------

    @Test
    fun `a signed entry refuses a change of the new columns and of its format, with check_violation`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val saved = save(boss, projectId, details = mapOf("dustMeasures" to "Kropení"))
        val id = UUID.fromString(saved.id)
        DailyReportService.signReport(boss, id)

        for (statement in listOf(
            """update daily_reports set "dustMeasures" = 'Jiné' where id = ?""",
            """update daily_reports set "accessibilityMeasures" = 'Jiné' where id = ?""",
            """update daily_reports set "signatureFormat" = 1 where id = ?""",
        )) {
            val refused = assertThrows<org.jooq.exception.DataAccessException>(statement) { dsl.execute(statement, id) }
            assertEquals("23514", refused.sqlState(), statement)
        }
        assertEquals("Kropení", record(saved.id).get(DAILY_REPORTS.DUSTMEASURES))
        assertEquals(2.toShort(), record(saved.id).get(DAILY_REPORTS.SIGNATUREFORMAT))
    }

    @Test
    fun `the audit rows of an update and of the signature carry the fields`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val saved = save(boss, projectId, details = mapOf("materials" to "Cement"))
        save(boss, projectId, details = mapOf("materials" to "Písek"))
        DailyReportService.signReport(boss, UUID.fromString(saved.id))

        fun json(action: String, column: org.jooq.TableField<*, org.jooq.JSONB?>) =
            dsl.select(column).from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).fetchSingle().get(0, org.jooq.JSONB::class.java)!!.data()

        val update = json("report.update", AUDIT_LOG.AFTER)
        assertTrue(update.contains("Písek"), update)
        assertTrue(json("report.update", AUDIT_LOG.BEFORE).contains("Cement"))
        // Signing keeps what was there on both sides of the audit row.
        assertTrue(json("report.lock", AUDIT_LOG.BEFORE).contains("Písek"))
        assertTrue(json("report.lock", AUDIT_LOG.AFTER).contains("Písek"))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a NUL character in a field, a trade or a name is refused with a message, not stored`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        assertThrows<IllegalArgumentException> { save(boss, projectId, details = mapOf("materials" to "Beton\u0000")) }
        assertThrows<IllegalArgumentException> { save(boss, projectId, workers = """[{"trade":"Zed\u0000ník","count":1}]""") }
        assertThrows<IllegalArgumentException> { save(boss, projectId, workers = """[{"trade":"Zedník","count":1,"names":["Jan\u0000"]}]""") }
        assertEquals(0, dsl.fetchCount(DAILY_REPORTS))
    }

    @Test
    fun `names at the limits are accepted, a hundred characters and as many names as workers`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val longName = "x".repeat(100)

        val saved = save(boss, projectId, workers = """[{"trade":"Zedníci","count":2,"names":["$longName","B"]}]""")

        assertTrue(saved.workersByTrade.contains(longName))
    }
}
