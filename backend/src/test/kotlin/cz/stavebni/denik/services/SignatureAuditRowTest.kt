package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.cli.AdminCli
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/**
 * A signature of format 3 is compared with the audit row that recorded it (`report.lock`, whose `after` holds the format, the
 * signer, the SHA-256 of part A and the signature hash). Whoever owns the table can switch the triggers off, edit the signer or
 * part A and compute the signature hash again (the algorithm is public): the entry then verifies against itself. The row of
 * the chain, which they cannot change without breaking the chain from that row on, is what they did not change.
 */
class SignatureAuditRowTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val projectId: UUID)

    private suspend fun site(): Site {
        val boss = createTestUser(nickname = "boss", displayName = "Jan Stavbyvedoucí", role = Role.BOSS, ckaitNumber = "0012345")
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Stavba", address = "Ulice 1", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        return Site(boss, UUID.fromString(project.id))
    }

    private suspend fun signedEntry(s: Site, day: String = "2026-09-28"): UUID {
        val saved = DailyReportService.saveReport(
            s.boss, s.projectId, day,
            DailyReportService.ReportInput(workDescription = "Betonáž", weather = WeatherData(8.5, 15.0, "zataženo")),
        )
        signUnchecked(s.boss, UUID.fromString(saved.id))
        return UUID.fromString(saved.id)
    }

    private fun cli(vararg args: String): Triple<Int, List<String>, List<String>> {
        val out = mutableListOf<String>()
        val err = mutableListOf<String>()
        return Triple(AdminCli.run(args.toList(), out::add, err::add), out, err)
    }

    /**
     * What an owner of the table can do: switch the triggers off, change the entry and make its hash fit again, as the application
     * itself would have made it. The entry then verifies against itself.
     */
    private fun forge(id: UUID, vararg assignments: String) {
        dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
        try {
            dsl.execute("""update daily_reports set ${assignments.joinToString(", ")} where id = ?""", id)
            val forged = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(id)).fetchSingle()
            val hash = ReportSignature.hash(dsl, forged, forged.signedat!!, forged.signedbyid!!)
            dsl.execute("""update daily_reports set "signatureHash" = ? where id = ?""", hash, id)
        } finally {
            dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
        }
    }

    private fun problemsOf(id: UUID): List<String> = ReportSignature.checkAll(dsl).problems.filter { it.contains(id.toString()) }

    @Test
    fun `an intact entry agrees with the audit row of its signature`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)

        val result = ReportSignature.checkAll(dsl)

        assertTrue(result.ok, result.problems.toString())
        assertEquals(0, cli("verify-signatures").first)
        assertEquals(1, result.signed)
        assertNotNull(dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("report.lock").and(AUDIT_LOG.ENTITY_ID.eq(id.toString()))).fetchOne())
    }

    @Test
    fun `an edit of what the audit row records is found although the signature hash was computed again`() = runBlocking<Unit> {
        val s = site()
        val cases = linkedMapOf(
            "signerName" to listOf(""""signerName" = 'Karel Cizí'"""),
            "signerCkaitNumber" to listOf(""""signerCkaitNumber" = '0099999'"""),
            "partASha256" to listOf(""""partASnapshot" = replace("partASnapshot", '"name":"Stavba"', '"name":"Stavbb"')"""),
            // The signature hash is the fifth thing the audit row records: any change of the covered content that is hidden by
            // computing the hash again changes it.
            "signatureHash" to listOf(""""workDescription" = 'Zfalšováno'"""),
            // The format: a format 3 entry made to look like an older one (which has no signer and no part A) and hashed as such.
            "signatureFormat" to listOf(""""signatureFormat" = 2, "signerName" = null, "signerCkaitNumber" = null, "partASnapshot" = null"""),
        )
        var day = 0
        for ((field, assignments) in cases) {
            val id = signedEntry(s, "2026-10-${(++day).toString().padStart(2, '0')}")
            assertTrue(problemsOf(id).isEmpty(), "before: $field")

            forge(id, *assignments.toTypedArray())

            // The entry now verifies against itself: that is what the forger did.
            assertEquals(true, ReportSignature.check(dsl, id).contentMatches, "$field: the entry is consistent with itself")
            val problems = problemsOf(id)
            assertEquals(1, problems.size, "$field: $problems")
            assertTrue(problems.single().contains("report.lock") && problems.single().contains(field), "$field: ${problems.single()}")
            // The report names the entry and the field, never the content.
            assertFalse(problems.single().contains("Karel Cizí") || problems.single().contains("Zfalšováno") || problems.single().contains("0099999"), problems.single())
            // Put things right for the next one: the entry is removed (its audit row stays, it is the chain's).
            dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
            try {
                dsl.execute("""delete from daily_reports where id = ?""", id)
            } finally {
                dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
            }
        }
    }

    @Test
    fun `the report says which fields differ, all of them`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)

        forge(id, """"signerName" = 'Karel Cizí'""", """"signerCkaitNumber" = '0099999'""")

        val problem = problemsOf(id).single()
        for (field in listOf("signerName", "signerCkaitNumber", "signatureHash")) assertTrue(problem.contains(field), "$field: $problem")
        assertFalse(problem.contains("partASha256") || problem.contains("signatureFormat"), problem)
    }

    @Test
    fun `a format 3 entry without the audit row of its signature fails`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)
        // The audit log refuses a delete; whoever owns the table can switch the guards off. (The chain after the row no longer fits
        // either, which `audit-verify` finds: this test is about what verify-signatures says by itself.)
        dsl.removeLockRowOf(id)

        val problems = problemsOf(id)

        assertEquals(1, problems.size, problems.toString())
        assertTrue(problems.single().contains("report.lock") && problems.single().contains("missing"), problems.single())
        val run = cli("verify-signatures")
        assertEquals(1, run.first)
        assertTrue(run.third.any { it.contains(id.toString()) && it.contains("report.lock") }, run.third.toString())
    }

    @Test
    fun `an entry of an older format keeps the behaviour it had, with or without an audit row`() = runBlocking<Unit> {
        // Test data signed before format 3: no audit row at all (the fixture), or one that never recorded a format.
        GoldenFixture.insertSignedEntry(dsl, signatureHash = "9".repeat(64), signatureFormat = 2)
        val result = ReportSignature.checkAll(dsl)
        assertFalse(result.problems.any { it.contains("report.lock") }, "an older entry is not compared with an audit row it never had: ${result.problems}")
    }

    @Test
    fun `a format 3 entry made to look older but whose audit row says 3 is found, which is a downgrade`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)

        forge(id, """"signatureFormat" = 1, "signerName" = null, "signerCkaitNumber" = null, "partASnapshot" = null""")

        val problems = problemsOf(id)
        assertTrue(problems.any { it.contains("signatureFormat") }, problems.toString())
    }

    @Test
    fun `the command exits 1, names the entry and the fields, and prints none of the forged content`() = runBlocking<Unit> {
        val s = site()
        val id = signedEntry(s)
        forge(id, """"signerName" = 'Karel Cizí'""")

        val run = cli("verify-signatures")

        assertEquals(1, run.first)
        assertTrue(run.third.any { it.contains(id.toString()) && it.contains("signerName") && it.contains("report.lock") }, run.third.toString())
        assertFalse(run.third.any { it.contains("Karel") }, "no content in the report: ${run.third}")
    }
}
