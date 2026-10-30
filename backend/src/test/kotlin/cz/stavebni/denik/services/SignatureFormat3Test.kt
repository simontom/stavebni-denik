package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.jooq.tables.records.DailyReportsRecord
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Signature format 3 (backlog C2): the signer's name and ČKAIT number and the identification of the diary are stored in the
 * statement that signs and covered by the signature, so that nothing that happens to the account or the project afterwards
 * changes what an entry says it was signed by, and under which identification.
 */
class SignatureFormat3Test : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val projectId: UUID)

    private suspend fun site(name: String = "Jan Stavbyvedoucí", ckait: String = "0012345"): Site {
        val boss = createTestUser(nickname = "boss", displayName = name, role = Role.BOSS, ckaitNumber = ckait)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Stavba", address = "Ulice 1", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        return Site(boss, UUID.fromString(project.id))
    }

    /** An entry with a weather, a worker with a name and a field of every kind, signed by [signer] (the site's manager by default). */
    private suspend fun signedEntry(s: Site, day: String = "2026-09-28", signer: SessionUser = s.boss): UUID {
        val saved = DailyReportService.saveReport(
            s.boss, s.projectId, day,
            DailyReportService.ReportInput(
                workDescription = "Betonáž",
                workersByTrade = """[{"trade":"Zedníci","count":1,"names":["Jan Novák"]}]""",
                weather = WeatherData(tempMin = 8.5, tempMax = 15.0, condition = "zataženo"),
                details = mapOf("materials" to "Cement", "workStateChanges" to "Práce zahájeny 28. 9. 2026"),
                lateEntryReason = null,
            ),
        )
        signUnchecked(signer, UUID.fromString(saved.id))
        return UUID.fromString(saved.id)
    }

    private fun record(id: UUID): DailyReportsRecord = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(id)).fetchSingle()

    /** A change made behind the application's back: the triggers of a signed entry are switched off for it (a table owner can do that). */
    private fun tamper(sql: String, vararg bindings: Any) {
        dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
        try {
            dsl.execute(sql, *bindings)
        } finally {
            dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
        }
    }

    // --- what is stored -----------------------------------------------------------------------------

    @Test
    fun `new signatures are made in format 3`() {
        assertEquals(3, ReportSignature.CURRENT_FORMAT)
    }

    @Test
    fun `signing stores the format, the signer and part A in the statement that signs, and the check agrees`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)

        val row = record(id)

        assertEquals(3.toShort(), row.get(DAILY_REPORTS.SIGNATUREFORMAT))
        assertEquals("Jan Stavbyvedoucí", row.get(DAILY_REPORTS.SIGNERNAME))
        assertEquals("0012345", row.get(DAILY_REPORTS.SIGNERCKAITNUMBER))
        assertEquals(PartASnapshot.build(dsl, s.projectId), row.get(DAILY_REPORTS.PARTASNAPSHOT), "nothing changed since, so it is part A as it is now")
        assertEquals(ReportSignature.hash(dsl, row, row.signedat!!, s.boss.id), row.get(DAILY_REPORTS.SIGNATUREHASH))
        val check = ReportSignature.check(dsl, id)
        assertEquals(3, check.signatureFormat)
        assertEquals(true, check.contentMatches)
        assertEquals(true, check.signerFrozen)
        assertEquals("Jan Stavbyvedoucí", check.signedByName)
        assertEquals("0012345", check.signerCkaitNumber)
        assertEquals(emptyList<String>(), check.missingFields)
        assertTrue(ReportSignature.checkAll(dsl).ok)
    }

    @Test
    fun `a deputy who signs is the signer, not the site manager`() = runBlocking<Unit> {
        val s = site()
        val deputy = createTestUser(nickname = "deputy", displayName = "Marie Zástupce", role = Role.BOSS, ckaitNumber = "0099999")
        addMember(s.projectId, deputy, Role.BOSS)

        val id = signedEntry(s, signer = deputy)

        assertEquals("Marie Zástupce", record(id).get(DAILY_REPORTS.SIGNERNAME))
        assertEquals("0099999", record(id).get(DAILY_REPORTS.SIGNERCKAITNUMBER))
        // Part A still names the site manager of the project: the signer is not necessarily that person.
        assertTrue(record(id).get(DAILY_REPORTS.PARTASNAPSHOT)!!.contains("Jan Stavbyvedoucí"))
    }

    @Test
    fun `the name and the number are stored as people read them, trimmed`() = runBlocking<Unit> {
        val s = site(name = "  Jan Stavbyvedoucí  ", ckait = " 0012345 ")

        val id = signedEntry(s)

        assertEquals("Jan Stavbyvedoucí", record(id).get(DAILY_REPORTS.SIGNERNAME))
        assertEquals("0012345", record(id).get(DAILY_REPORTS.SIGNERCKAITNUMBER))
    }

    // --- what the account and the project do afterwards -----------------------------------------------

    @Test
    fun `renaming the signer, or changing or clearing their number, changes nothing an earlier entry says`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)

        dsl.update(USERS).set(USERS.DISPLAYNAME, "Úplně Jiné Jméno").set(USERS.CKAITNUMBER, "7777777").where(USERS.ID.eq(s.boss.id)).execute()
        var check = ReportSignature.check(dsl, id)
        assertEquals(true, check.contentMatches, "the signature does not read the account any more")
        assertEquals("Jan Stavbyvedoucí", check.signedByName)
        assertEquals("0012345", check.signerCkaitNumber)

        dsl.update(USERS).setNull(USERS.CKAITNUMBER).where(USERS.ID.eq(s.boss.id)).execute()
        check = ReportSignature.check(dsl, id)
        assertEquals(true, check.contentMatches)
        assertEquals("0012345", check.signerCkaitNumber)
        assertTrue(ReportSignature.checkAll(dsl).ok)
    }

    @Test
    fun `a change of the project after signing changes neither the stored part A nor the signature`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)
        val before = record(id).get(DAILY_REPORTS.PARTASNAPSHOT)!!
        val current = ProjectService.getProject(dsl, s.boss, s.projectId)

        ProjectService.updateProject(s.boss, s.projectId, current.copy(name = "Přejmenovaná stavba", contractor = "Jiný zhotovitel", authorSupervisionName = "Nový dozor"))
        val intern = createTestUser(nickname = "intern", role = Role.INSPECTOR)
        addMember(s.projectId, intern, Role.INSPECTOR)

        assertEquals(before, record(id).get(DAILY_REPORTS.PARTASNAPSHOT))
        assertEquals(true, ReportSignature.check(dsl, id).contentMatches)
        assertTrue(before.contains("\"name\":\"Stavba\""), before)
        assertFalse(before.contains("Přejmenovaná"), "the snapshot is what it was")
    }

    @Test
    fun `the snapshot is part A as it was when the entry was signed, including the persons who were there`() = runBlocking<Unit> {
        val s = site()
        val supervisor = createTestUser(nickname = "dozor", displayName = "Ing. Dozor", role = Role.INSPECTOR, ckaitNumber = null)
        addMember(s.projectId, supervisor, Role.INSPECTOR)
        dsl.update(PROJECT_MEMBERS).set(PROJECT_MEMBERS.SCOPE, "Technický dozor stavebníka").where(PROJECT_MEMBERS.USERID.eq(supervisor.id)).execute()
        val person = AuthorizedPersonService.create(s.boss, s.projectId, CreateAuthorizedPersonRequest("Ing. Arch. Petr Černý", "Architekti s.r.o.", "Autorský dozor"))

        val id = signedEntry(s)
        AuthorizedPersonService.revoke(s.boss, UUID.fromString(person.id))
        dsl.update(PROJECT_MEMBERS).set(PROJECT_MEMBERS.SCOPE, "Něco jiného").where(PROJECT_MEMBERS.USERID.eq(supervisor.id)).execute()

        val part = PartASnapshot.parse(record(id).get(DAILY_REPORTS.PARTASNAPSHOT)!!)
        assertEquals(listOf("Jan Stavbyvedoucí", "Ing. Dozor"), part.members.map { it.name })
        assertEquals("Technický dozor stavebníka", part.members.last().scope, "the scope as it was, not as it is")
        assertEquals(listOf("Ing. Arch. Petr Černý"), part.authorizedPersons.map { it.name }, "the person who was active then is there, although revoked since")
        assertEquals(true, ReportSignature.check(dsl, id).contentMatches)
    }

    // --- what the signature covers ---------------------------------------------------------------------

    @Test
    fun `a byte changed behind the application's back in anything format 3 covers breaks the signature`() = runBlocking<Unit> {
        val s = site()
        val changes = linkedMapOf(
            "the signer's name" to """update daily_reports set "signerName" = 'Karel Cizí' where id = ?""",
            "the signer's number" to """update daily_reports set "signerCkaitNumber" = '0012346' where id = ?""",
            "one letter of part A" to """update daily_reports set "partASnapshot" = replace("partASnapshot", '"name":"Stavba"', '"name":"Stavbb"') where id = ?""",
            "a person of part A" to """update daily_reports set "partASnapshot" = replace("partASnapshot", 'Jan Stavbyvedoucí', 'Jan Stavbyvedoucí2') where id = ?""",
            "the start, interruption and resumption of work" to """update daily_reports set "workStateChanges" = 'Práce zahájeny 29. 9. 2026' where id = ?""",
            "a field of the vyhláška" to """update daily_reports set "materialsIn" = 'Písek' where id = ?""",
            "the work description" to """update daily_reports set "workDescription" = 'Zfalšováno' where id = ?""",
            "a name of a worker" to """update daily_reports set "workersByTrade" = '[{"trade":"Zedníci","count":1,"names":["Karel Cizí"]}]'::jsonb where id = ?""",
            "the temperature" to """update daily_reports set weather = '{"tempMin":8.5,"tempMax":15.5,"condition":"zataženo"}'::jsonb where id = ?""",
            "the condition of the weather" to """update daily_reports set weather = '{"tempMin":8.5,"tempMax":15.0,"condition":"jasno"}'::jsonb where id = ?""",
            "no weather at all" to """update daily_reports set weather = null where id = ?""",
            "the construction object" to """update daily_reports set "constructionObj" = 'SO 99' where id = ?""",
            "the control-day flag" to """update daily_reports set "isControlDay" = true where id = ?""",
        )
        var day = 0
        for ((what, sql) in changes) {
            val id = signedEntry(s, day = "2026-10-${(++day).toString().padStart(2, '0')}")
            assertEquals(true, ReportSignature.check(dsl, id).contentMatches, "before: $what")

            tamper(sql, id)

            assertEquals(false, ReportSignature.check(dsl, id).contentMatches, "a change of $what must break the signature")
            assertFalse(ReportSignature.checkAll(dsl).ok)
            // The next entry is checked on its own: remove this one from the way.
            tamper("""delete from daily_reports where id = ?""", id)
        }
    }

    @Test
    fun `the weather is covered as its text, not as the digits it is stored in`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)

        // The same weather written another way (8.50, 15 and the keys in another order) says the same text, and signs the same.
        tamper("""update daily_reports set weather = '{"condition":"zataženo","tempMax":15,"tempMin":8.50}'::jsonb where id = ?""", id)
        assertEquals(true, ReportSignature.check(dsl, id).contentMatches, "the text of the weather is what is signed")

        tamper("""update daily_reports set weather = '{"condition":"zataženo","tempMax":15.5,"tempMin":8.5}'::jsonb where id = ?""", id)
        assertEquals(false, ReportSignature.check(dsl, id).contentMatches)
    }

    @Test
    fun `an entry without a weather is signed as no weather`() = runBlocking<Unit> {
        val s = site()
        val saved = DailyReportService.saveReport(s.boss, s.projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Bez počasí"))
        signUnchecked(s.boss, UUID.fromString(saved.id))

        val content = ReportSignature.content(dsl, record(UUID.fromString(saved.id)), OffsetDateTime.parse("2026-09-28T10:00:00Z"), s.boss.id)

        assertEquals("null", content["weather"].toString())
        assertEquals(true, ReportSignature.check(dsl, UUID.fromString(saved.id)).contentMatches)
    }

    @Test
    fun `the covered content has exactly the keys that are listed, the columns of an entry are accounted for`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)
        val row = record(id)

        val content = ReportSignature.content(dsl, row, row.signedat!!, s.boss.id)

        assertEquals(
            ReportSignature.FORMAT_3_COLUMNS.map { it.name }.toSet() + setOf("format", "photos", "details", "partASha256"),
            content.keys,
            "the content of format 3 has the keys of FORMAT_3_COLUMNS and four more",
        )
        assertEquals(ReportSignature.FORMAT_3_DETAIL_KEYS.toSet(), content["details"]!!.jsonObject.keys)
        assertEquals(PartASnapshot.sha256(row.get(DAILY_REPORTS.PARTASNAPSHOT)!!), content["partASha256"]!!.jsonPrimitive.content)

        val notCovered = mapOf(
            "meetingNotes" to "unused legacy column", "meetingAttendees" to "unused legacy column", "workSuspended" to "unused legacy column",
            "suspensionReason" to "unused legacy column (workStateChanges replaces it)",
            "createdAt" to "bookkeeping", "updatedAt" to "bookkeeping (a signed entry cannot change it, V11)", "createdById" to "bookkeeping",
            "deletedAt" to "a removed entry is not exported",
            "signatureHash" to "the signature itself", "signatureFormat" to "inside the content as `format`", "lockedAt" to "the moment of signing is `signedAt`",
            "partASnapshot" to "covered by its SHA-256, `partASha256`",
            "authorName" to "printed as stored when the entry was made (backlog B9); the signature covers the author by `authorId`",
        )
        val covered = ReportSignature.FORMAT_3_COLUMNS.map { it.name }.toSet() + EntryDetails.FIELDS.map { it.column.name }
        val columns = DAILY_REPORTS.fields().map { it.name }.toSet()
        assertEquals(
            emptySet<String>(), columns - covered - notCovered.keys,
            "A column was added to daily_reports. Format 3 covers a frozen list of columns (ReportSignature.FORMAT_3_COLUMNS): a column that must be signed needs a " +
                "format 4, one that must not is added to notCovered in this test with its reason.",
        )
    }

    // --- a signature that lacks what it needs ----------------------------------------------------------

    @Test
    fun `a format 3 entry that lost its signer, its number or its part A is a failure, not nothing to compare`() = runBlocking<Unit> {
        val s = site()
        val cases = mapOf(
            "signerName" to """update daily_reports set "signerName" = null where id = ?""",
            "signerCkaitNumber" to """update daily_reports set "signerCkaitNumber" = '  ' where id = ?""",
            "partASnapshot" to """update daily_reports set "partASnapshot" = null where id = ?""",
        )
        var day = 0
        for ((missing, sql) in cases) {
            val id = signedEntry(s, day = "2026-11-${(++day).toString().padStart(2, '0')}")
            // The database refuses such a row; whoever owns the table can switch the constraint off, like a trigger.
            dsl.withoutConstraint("daily_reports_signature_format_3_check", table = "daily_reports") { tamper(sql, id) }

            val check = ReportSignature.check(dsl, id)

            assertEquals(false, check.contentMatches, "$missing missing")
            assertEquals(listOf(missing), check.missingFields)
            val problems = ReportSignature.checkAll(dsl).problems
            assertTrue(problems.any { it.contains(id.toString()) && it.contains(missing) }, "$missing: $problems")
            tamper("""delete from daily_reports where id = ?""", id)
        }
    }

    @Test
    fun `a format 3 entry without its hash is a failure too`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)
        tamper("""update daily_reports set "signatureHash" = null where id = ?""", id)

        assertEquals(false, ReportSignature.check(dsl, id).contentMatches)
        assertTrue(ReportSignature.checkAll(dsl).problems.any { it.contains("signature hash is missing") })
    }

    // --- the database ------------------------------------------------------------------------------

    private fun refused(sql: String, vararg bindings: Any): DataAccessException = assertThrows<DataAccessException>(sql) { dsl.execute(sql, *bindings) }

    @Test
    fun `the database refuses a format that is not whole, and a format that does not exist`() = runBlocking<Unit> {
        val s = site()
        val draft = UUID.fromString(DailyReportService.saveReport(s.boss, s.projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Koncept")).id)

        // The number given at signing is the right one (1), so that the trigger of V13 has nothing to say and it is the
        // constraint of V14 that refuses.
        val locked = """"sequenceNumber" = 1, "lockedAt" = now()"""
        val statements = listOf(
            // a draft cannot be in format 3, nor carry a signer or a snapshot
            """update daily_reports set "signatureFormat" = 3 where id = ?""",
            """update daily_reports set "signerName" = 'Jan' where id = ?""",
            """update daily_reports set "partASnapshot" = '{}' where id = ?""",
            // there is no format 4
            """update daily_reports set "signatureFormat" = 4 where id = ?""",
            // locked, in format 3, but one of the three is missing, or blank
            """update daily_reports set "signatureFormat" = 3, $locked, "signerCkaitNumber" = '1', "partASnapshot" = '{}' where id = ?""",
            """update daily_reports set "signatureFormat" = 3, $locked, "signerName" = 'Jan', "partASnapshot" = '{}' where id = ?""",
            """update daily_reports set "signatureFormat" = 3, $locked, "signerName" = 'Jan', "signerCkaitNumber" = '1' where id = ?""",
            """update daily_reports set "signatureFormat" = 3, $locked, "signerName" = ' ', "signerCkaitNumber" = '1', "partASnapshot" = '{}' where id = ?""",
            // a signed entry of format 2 has none of the three
            """update daily_reports set "signatureFormat" = 2, $locked, "signerName" = 'Jan' where id = ?""",
        )
        for (statement in statements) {
            val error = refused(statement, draft)
            assertEquals("23514", error.sqlState(), statement)
            assertTrue(error.message!!.contains("daily_reports_signature_format"), "refused by the constraint of V14, not by another rule: ${error.message}")
        }
        assertEquals(1.toShort(), record(draft).get(DAILY_REPORTS.SIGNATUREFORMAT))
        assertNull(record(draft).get(DAILY_REPORTS.LOCKEDAT))

        // A whole one is accepted (the control of this test).
        dsl.execute(
            """update daily_reports set "signatureFormat" = 3, $locked, "signerName" = 'Jan', "signerCkaitNumber" = '1', "partASnapshot" = '{}' where id = ?""",
            draft,
        )
        assertEquals(3.toShort(), record(draft).get(DAILY_REPORTS.SIGNATUREFORMAT))
    }

    @Test
    fun `a signed entry refuses a change or a deletion of its signer and of part A`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)

        for (statement in listOf(
            """update daily_reports set "signerName" = 'Karel Cizí' where id = ?""",
            """update daily_reports set "signerCkaitNumber" = '1' where id = ?""",
            """update daily_reports set "partASnapshot" = '{}' where id = ?""",
            """update daily_reports set "workStateChanges" = 'jiné' where id = ?""",
            """update daily_reports set "signatureFormat" = 2, "signerName" = null, "signerCkaitNumber" = null, "partASnapshot" = null where id = ?""",
            """delete from daily_reports where id = ?""",
        )) {
            assertEquals("23514", refused(statement, id).sqlState(), statement)
        }
        assertEquals("Jan Stavbyvedoucí", record(id).get(DAILY_REPORTS.SIGNERNAME))
        assertEquals(3.toShort(), record(id).get(DAILY_REPORTS.SIGNATUREFORMAT))
    }

    // --- refusals at signing -----------------------------------------------------------------------------

    @Test
    fun `a part A that is too large refuses the signature and signs nothing`() = runBlocking<Unit> {
        val s = site()
        val saved = DailyReportService.saveReport(s.boss, s.projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Betonáž"))
        dsl.update(PROJECTS).set(PROJECTS.SUPPORTINGDOCUMENTS, "x".repeat(PartASnapshot.MAX_BYTES + 1)).where(PROJECTS.ID.eq(s.projectId)).execute()

        val refused = assertThrows<ConflictException> { signUnchecked(s.boss, UUID.fromString(saved.id)) }

        assertTrue(refused.message!!.contains("příliš rozsáhlé"), refused.message)
        val row = record(UUID.fromString(saved.id))
        assertNull(row.lockedat, "nothing was signed")
        assertNull(row.get(DAILY_REPORTS.SIGNERNAME))
        assertEquals(0, dsl.fetchCount(AUDIT_LOG, AUDIT_LOG.ACTION.eq("report.lock")), "and nothing was written to the audit log")
    }

    // --- the audit log ---------------------------------------------------------------------------------

    @Test
    fun `the audit row of the signature holds the format, the signer and the digest of part A`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)

        val after = Json.parseToJsonElement(dsl.auditPartOf("report.lock", "after")!!).jsonObject
        val before = Json.parseToJsonElement(dsl.auditPartOf("report.lock", "before")!!).jsonObject

        assertEquals("3", after["signatureFormat"]!!.jsonPrimitive.content)
        assertEquals("Jan Stavbyvedoucí", after["signerName"]!!.jsonPrimitive.content)
        assertEquals("0012345", after["signerCkaitNumber"]!!.jsonPrimitive.content)
        assertEquals(PartASnapshot.sha256(record(id).get(DAILY_REPORTS.PARTASNAPSHOT)!!), after["partASha256"]!!.jsonPrimitive.content)
        assertEquals(record(id).get(DAILY_REPORTS.SIGNATUREHASH), after["signatureHash"]!!.jsonPrimitive.content)
        for (key in listOf("signatureFormat", "signerName", "signerCkaitNumber", "partASha256")) assertFalse(before.containsKey(key), "a draft has no $key")
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `the audit rows of a draft are the ones they were before this format`() = runBlocking<Unit> {
        val s = site()
        DailyReportService.saveReport(s.boss, s.projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Koncept"))

        val after = Json.parseToJsonElement(dsl.auditPartOf("report.create", "after")!!).jsonObject

        for (key in listOf("signatureFormat", "signerName", "signerCkaitNumber", "partASha256")) assertFalse(after.containsKey(key), "a draft has no $key")
    }
}
