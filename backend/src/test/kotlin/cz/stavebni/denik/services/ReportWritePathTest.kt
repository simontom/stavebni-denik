package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/**
 * The write path of daily reports: who may change a report, what a signature is,
 * and what the audit log records about it.
 */
class ReportWritePathTest : BaseIntegrationTest() {

    private suspend fun createProject(owner: SessionUser, name: String = "Write Path Project"): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = name, address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor",
                siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private fun report(id: String) =
        dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(id))).fetchOne()!!

    private fun auditRows(action: String) =
        dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.asc()).fetch()

    private fun parse(json: String?): JsonObject = Json.parseToJsonElement(json!!).jsonObject

    // --- signing ----------------------------------------------------------------------------

    @Test
    fun `signing records who and when, and the audit row names the report and its state`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž")

        DailyReportService.lockReport(boss, UUID.fromString(created.id))

        val signed = report(created.id)
        assertNotNull(signed.signedat)
        assertNotNull(signed.lockedat)
        assertEquals(boss.id, signed.get(DAILY_REPORTS.SIGNEDBYID))

        val row = auditRows("report.lock").single()
        assertEquals(created.id, row.get(AUDIT_LOG.ENTITY_ID), "the audit row must name the report")
        assertEquals(boss.id.toString(), row.get(AUDIT_LOG.ACTOR_ID))
        val before = parse(row.get(AUDIT_LOG.BEFORE)?.data())
        val after = parse(row.get(AUDIT_LOG.AFTER)?.data())
        assertTrue(before["lockedAt"] is JsonNull, "the report was not locked before the signature")
        assertNotNull(after["lockedAt"]!!.jsonPrimitive.content)
        assertEquals("Betonáž", after["workDescription"]!!.jsonPrimitive.content)
        assertEquals(boss.id.toString(), after["signedById"]!!.jsonPrimitive.content)

        assertTrue(AuditService.verifyChain(dsl).ok, "the hash chain must verify with before/after snapshots")
    }

    @Test
    fun `a signed report cannot be signed again and the first signature stays`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val secondBoss = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        addMember(projectId, secondBoss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28")
        val reportId = UUID.fromString(created.id)
        DailyReportService.lockReport(boss, reportId)
        val first = report(created.id)

        assertThrows<ConflictException> { DailyReportService.lockReport(secondBoss, reportId) }

        val after = report(created.id)
        assertEquals(boss.id, after.get(DAILY_REPORTS.SIGNEDBYID), "the first signer must stay")
        assertEquals(first.signedat, after.signedat, "the signing time must not move")
        assertEquals(1, auditRows("report.lock").size, "a refused signature leaves no audit row")
    }

    @Test
    fun `two concurrent signatures end in exactly one signature`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val secondBoss = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        addMember(projectId, secondBoss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28")
        val reportId = UUID.fromString(created.id)

        val outcomes = coroutineScope {
            listOf(boss, secondBoss)
                .map { signer -> async(Dispatchers.Default) { runCatching { DailyReportService.lockReport(signer, reportId) } } }
                .awaitAll()
        }

        assertEquals(1, outcomes.count { it.isSuccess })
        assertTrue(outcomes.single { it.isFailure }.exceptionOrNull() is ConflictException)
        assertEquals(1, auditRows("report.lock").size)
    }

    @Test
    fun `a BOSS who is not a member of the project cannot sign`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val outsider = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28")

        assertThrows<ForbiddenException> { DailyReportService.lockReport(outsider, UUID.fromString(created.id)) }

        assertNull(report(created.id).lockedat)
    }

    @Test
    fun `an app admin who is not a member cannot sign`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val adminBoss = createTestUser(role = Role.BOSS, isAdmin = true)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28")

        assertThrows<ForbiddenException> { DailyReportService.lockReport(adminBoss, UUID.fromString(created.id)) }

        assertNull(report(created.id).lockedat, "being an admin must not grant the right to sign")
    }

    @Test
    fun `signing an unknown report is a not-found error`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            assertThrows<NotFoundException> { DailyReportService.lockReport(boss, UUID.randomUUID()) }
        }
    }

    // --- acknowledging ----------------------------------------------------------------------

    @Test
    fun `a report can only be acknowledged after it is signed, and only once`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val inspector = createTestUser(role = Role.INSPECTOR)
        val investor = createTestUser(role = Role.INVESTOR)
        val projectId = createProject(boss)
        addMember(projectId, inspector)
        addMember(projectId, investor)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28")
        val reportId = UUID.fromString(created.id)

        assertThrows<ConflictException> { DailyReportService.acknowledgeReport(inspector, reportId) }
        assertNull(report(created.id).acknowledgedat, "an unsigned report must not be acknowledgeable")

        DailyReportService.lockReport(boss, reportId)
        DailyReportService.acknowledgeReport(inspector, reportId)
        val acknowledged = report(created.id)
        assertEquals(inspector.id, acknowledged.get(DAILY_REPORTS.ACKNOWLEDGEDBYID))

        assertThrows<ConflictException> { DailyReportService.acknowledgeReport(investor, reportId) }
        val unchanged = report(created.id)
        assertEquals(inspector.id, unchanged.get(DAILY_REPORTS.ACKNOWLEDGEDBYID), "the first acknowledgement stays")
        assertEquals(acknowledged.acknowledgedat, unchanged.acknowledgedat)
        assertEquals(1, auditRows("report.acknowledge").size)
    }

    @Test
    fun `an inspector who is not a member of the project cannot acknowledge, even as app admin`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val adminInspector = createTestUser(role = Role.INSPECTOR, isAdmin = true)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28")
        val reportId = UUID.fromString(created.id)
        DailyReportService.lockReport(boss, reportId)

        assertThrows<ForbiddenException> { DailyReportService.acknowledgeReport(adminInspector, reportId) }

        assertNull(report(created.id).acknowledgedat)
    }

    // --- creating and overwriting -----------------------------------------------------------

    @Test
    fun `an app admin who is not a member cannot create or overwrite a report`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val adminBoss = createTestUser(role = Role.BOSS, isAdmin = true)
        val adminWorker = createTestUser(role = Role.WORKER, isAdmin = true)
        val projectId = createProject(boss)
        val existing = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Původní text")

        for (outsider in listOf(adminBoss, adminWorker)) {
            assertThrows<ForbiddenException> { DailyReportService.createReport(outsider, projectId, "2026-09-29") }
            assertThrows<ForbiddenException> {
                DailyReportService.saveReport(outsider, projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Přepsáno"))
            }
        }

        assertEquals(1, dsl.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)))
        assertEquals("Původní text", report(existing.id).workdescription)
    }

    @Test
    fun `creating a report in an unknown project is a not-found error`() {
        runBlocking {
            val boss = createTestUser(role = Role.BOSS)
            assertThrows<NotFoundException> { DailyReportService.createReport(boss, UUID.randomUUID(), "2026-09-28") }
        }
    }

    @Test
    fun `a signed report cannot be overwritten`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Podepsaný text")
        DailyReportService.lockReport(boss, UUID.fromString(created.id))

        assertThrows<ConflictException> {
            DailyReportService.saveReport(boss, projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Jiný text"))
        }

        assertEquals("Podepsaný text", report(created.id).workdescription)
    }

    @Test
    fun `audit rows of create and update name the report and keep its before and after state`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "První verze")
        DailyReportService.saveReport(boss, projectId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Druhá verze"))

        val createRow = auditRows("report.create").single()
        assertEquals(created.id, createRow.get(AUDIT_LOG.ENTITY_ID), "the audit row must name the new report")
        assertNull(createRow.get(AUDIT_LOG.BEFORE))
        assertEquals("První verze", parse(createRow.get(AUDIT_LOG.AFTER)?.data())["workDescription"]!!.jsonPrimitive.content)

        val updateRow = auditRows("report.update").single()
        assertEquals(created.id, updateRow.get(AUDIT_LOG.ENTITY_ID))
        assertEquals("První verze", parse(updateRow.get(AUDIT_LOG.BEFORE)?.data())["workDescription"]!!.jsonPrimitive.content)
        assertEquals("Druhá verze", parse(updateRow.get(AUDIT_LOG.AFTER)?.data())["workDescription"]!!.jsonPrimitive.content)

        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a failed change leaves no audit row behind`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val outsider = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        val created = DailyReportService.createReport(boss, projectId, "2026-09-28")
        val rowsBefore = dsl.fetchCount(AUDIT_LOG)

        assertThrows<ForbiddenException> { DailyReportService.lockReport(outsider, UUID.fromString(created.id)) }

        assertEquals(rowsBefore, dsl.fetchCount(AUDIT_LOG))
    }

    // --- reading ----------------------------------------------------------------------------

    @Test
    fun `a report id of another project is not readable through this project`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val projectA = createProject(boss, "Project A")
        val projectB = createProject(boss, "Project B")
        val reportOfB = DailyReportService.createReport(boss, projectB, "2026-09-28")

        assertNull(DailyReportService.getReport(projectA, reportOfB.id), "project A must not expose project B's report")
        assertNull(DailyReportService.getReport(projectA, "2026-09-28"))
        assertEquals(reportOfB.id, DailyReportService.getReport(projectB, reportOfB.id)?.id)
        assertEquals(reportOfB.id, DailyReportService.getReport(projectB, "2026-09-28")?.id)
    }
}
