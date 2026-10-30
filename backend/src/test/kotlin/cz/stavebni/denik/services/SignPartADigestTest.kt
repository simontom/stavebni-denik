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
import java.io.File
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

        val refused = assertThrows<StaleVersionException> { DailyReportService.signReport(boss, report, PartACheck.Seen("0".repeat(64))) }

        assertTrue(refused.message!!.contains("Údaje o stavbě"), refused.message)
        assertNull(dsl.select(DAILY_REPORTS.LOCKEDAT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchOne(DAILY_REPORTS.LOCKEDAT))
        assertEquals(rowsBefore, dsl.fetchCount(AUDIT_LOG), "the refusal rolled back with the transaction")

        DailyReportService.signReport(boss, report, PartACheck.Seen(partADigest(projectId)))
        assertNotNull(dsl.select(DAILY_REPORTS.LOCKEDAT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchOne(DAILY_REPORTS.LOCKEDAT))
    }

    @Test
    fun `what is stored is what the digest named, also when the project changes just after`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val projectId = UUID.fromString(ProjectService.createProject(boss, projectDto(boss)).id)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-29").id)
        val named = partADigest(projectId)

        DailyReportService.signReport(boss, report, PartACheck.Seen(named))
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(deputy.id.toString(), "BOSS", scope = "Po podpisu"))

        val stored = dsl.select(DAILY_REPORTS.PARTASNAPSHOT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchOne(DAILY_REPORTS.PARTASNAPSHOT)!!
        assertEquals(named, PartASnapshot.sha256(stored))
        assertNotEquals(named, partADigest(projectId), "the project has moved on; the signed entry has not")
    }

    @Test
    fun `the digest is normalised by the service itself, so a direct caller with upper case or blanks is not refused falsely`() = runBlocking<Unit> {
        assertEquals("abc123", PartACheck.Seen("  ABC123 \n").sha256, "trimmed and in lower case")

        val boss = createTestUser(role = Role.BOSS)
        val projectId = UUID.fromString(ProjectService.createProject(boss, projectDto(boss)).id)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-29").id)

        DailyReportService.signReport(boss, report, PartACheck.Seen("  ${partADigest(projectId).uppercase()}\n"))

        assertNotNull(dsl.select(DAILY_REPORTS.LOCKEDAT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchOne(DAILY_REPORTS.LOCKEDAT), "signed")
    }

    @Test
    fun `a blank or malformed digest is a digest that matches nothing, so it is refused and never taken for no check`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = UUID.fromString(ProjectService.createProject(boss, projectDto(boss)).id)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-29").id)

        for (digest in listOf("", "   ", "abc", "z".repeat(64))) {
            assertThrows<StaleVersionException>("'$digest'") { DailyReportService.signReport(boss, report, PartACheck.Seen(digest)) }
        }
        assertNull(dsl.select(DAILY_REPORTS.LOCKEDAT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(report)).fetchOne(DAILY_REPORTS.LOCKEDAT))
    }

    @Test
    fun `the way to sign without naming part A is used by no file of the application, only by tests`() {
        val root = generateSequence(File(".").absoluteFile.normalize()) { it.parentFile }.first { File(it, "PROJECT.md").isFile }
        val main = File(root, "backend/src/main/kotlin")
        val users = main.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .filter { file -> file.readText().let { "PartACheck.Unchecked" in it || "SignsWithoutPartACheck" in it } }
            .map { it.name }.toList()
        // The definition (and its KDoc) is in DailyReportService.kt; nothing else may mention it, the routes least of all.
        assertEquals(listOf("DailyReportService.kt"), users)
        // In the code of the service itself (not its comments) it is only defined, never passed.
        val code = File(main, "cz/stavebni/denik/services/DailyReportService.kt").readLines().filterNot { it.trim().let { l -> l.startsWith("*") || l.startsWith("/*") || l.startsWith("//") } }
        assertEquals(listOf("    data object Unchecked : PartACheck"), code.filter { "Unchecked" in it }, "the service itself never passes it either")
        val routes = File(main, "cz/stavebni/denik/routes/ReportRoutes.kt").readText()
        assertTrue("PartACheck.Seen(" in routes, "the routes name the digest")
    }
}
