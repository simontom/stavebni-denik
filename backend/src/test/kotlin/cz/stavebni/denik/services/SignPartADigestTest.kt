package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.StaleVersionException
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/** The digest of part A that a signer names (backlog C2b), checked where the signature is made: inside the signing transaction. */
class SignPartADigestTest : BaseIntegrationTest() {

    private fun projectDto(boss: cz.stavebni.denik.domain.SessionUser) = ProjectDto(
        id = "", name = "Hala", address = "Brno", cadastralArea = "Brno", parcelNumbers = "1",
        builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
    )

    @Test
    fun `the snapshot that is taken carries the text that is stored and the digest that is named`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = UUID.fromString(ProjectService.createProject(boss, projectDto(boss)).id)

        val taken = PartASnapshot.take(dsl, projectId)

        assertEquals(PartASnapshot.build(dsl, projectId), taken.text, "build is the text of take")
        assertEquals(taken.text, PartASnapshot.textOf(taken.partA))
        assertEquals(PartASnapshot.sha256(taken.text), taken.sha256)
        assertEquals(taken.partA, PartASnapshot.parse(taken.text), "the structure is what the text says")
    }

    @Test
    fun `signing with the digest of another part A refuses with STALE_VERSION and leaves the entry a draft with no audit row`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = UUID.fromString(ProjectService.createProject(boss, projectDto(boss)).id)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-29").id)
        val rowsBefore = dsl.fetchCount(AUDIT_LOG)

        val refused = assertThrows<StaleVersionException> { DailyReportService.signReport(boss, report, expectedPartASha256 = "0".repeat(64)) }

        assertTrue(refused.message!!.contains("Údaje o stavbě"), refused.message)
        assertNull(dsl.select(DAILY_REPORTS.LOCKEDAT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchOne(DAILY_REPORTS.LOCKEDAT))
        assertEquals(rowsBefore, dsl.fetchCount(AUDIT_LOG), "the refusal rolled back with the transaction")

        DailyReportService.signReport(boss, report, expectedPartASha256 = partADigest(projectId))
        assertNotNull(dsl.select(DAILY_REPORTS.LOCKEDAT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchOne(DAILY_REPORTS.LOCKEDAT))
    }

    @Test
    fun `what is stored is what the digest named, also when the project changes just after`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val projectId = UUID.fromString(ProjectService.createProject(boss, projectDto(boss)).id)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-29").id)
        val named = partADigest(projectId)

        DailyReportService.signReport(boss, report, expectedPartASha256 = named)
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(deputy.id.toString(), "BOSS", scope = "Po podpisu"))

        val stored = dsl.select(DAILY_REPORTS.PARTASNAPSHOT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchOne(DAILY_REPORTS.PARTASNAPSHOT)!!
        assertEquals(named, PartASnapshot.sha256(stored))
        assertNotEquals(named, partADigest(projectId), "the project has moved on; the signed entry has not")
    }
}
