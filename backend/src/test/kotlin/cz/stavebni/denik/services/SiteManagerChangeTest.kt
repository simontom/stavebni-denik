package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.StaleVersionException
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
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

/** Replacing the site manager (stavbyvedoucí) of a project: who may, who may be named, and that it is traceable. */
class SiteManagerChangeTest : BaseIntegrationTest() {

    private suspend fun project(manager: SessionUser): ProjectDto =
        ProjectService.createProject(
            manager,
            ProjectDto(
                id = "", name = "Dům", address = "Karlova 15", cadastralArea = "Brno", parcelNumbers = "1",
                builder = "Město", contractor = "Stavitel", siteManagerId = manager.id.toString(),
            )
        )

    private fun siteManagerOf(projectId: String): UUID = dsl.select(PROJECTS.SITEMANAGERID).from(PROJECTS).where(PROJECTS.ID.eq(UUID.fromString(projectId))).fetchSingle(PROJECTS.SITEMANAGERID)!!

    private fun request(project: ProjectDto, newManager: SessionUser, reason: String? = null) =
        SiteManagerChangeRequest(newManager.id.toString(), reason, project.updatedAt)

    @Test
    fun `the manager replaces the site manager with another manager of the project`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "Původní Vedoucí")
        val deputy = createTestUser(role = Role.BOSS, displayName = "Nový Vedoucí")
        val created = project(boss)
        val id = UUID.fromString(created.id)
        addMember(id, deputy, Role.BOSS)

        val changed = ProjectService.changeSiteManager(boss, id, request(created, deputy, "Původní stavbyvedoucí odešel ze společnosti"))

        assertEquals(deputy.id.toString(), changed.siteManagerId)
        assertEquals(deputy.id, siteManagerOf(created.id))
        assertNotEquals(created.updatedAt, changed.updatedAt, "a new version of the project")
        val row = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("project.site_manager.change")).fetchSingle()
        assertEquals(created.id, row.get(AUDIT_LOG.ENTITY_ID))
        val before = row.get(AUDIT_LOG.BEFORE)!!.data()
        val after = row.get(AUDIT_LOG.AFTER)!!.data()
        assertTrue(before.contains("Původní Vedoucí") && before.contains(boss.id.toString()), before)
        assertTrue(after.contains("Nový Vedoucí") && after.contains(deputy.id.toString()), after)
        assertTrue(after.contains("odešel ze společnosti"), "the reason is kept: $after")
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `only someone who can sign may be named`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val created = project(boss)
        val id = UUID.fromString(created.id)
        val worker = createTestUser(role = Role.WORKER).also { addMember(id, it, Role.WORKER) }
        val outsider = createTestUser(role = Role.BOSS)
        val noCkait = createTestUser(role = Role.BOSS).also { addMember(id, it, Role.BOSS) }
        dsl.execute("""update users set "ckaitNumber" = null where id = ?""", noCkait.id)
        val inactive = createTestUser(role = Role.BOSS).also { addMember(id, it, Role.BOSS) }
        dsl.execute("""update users set "isActive" = false where id = ?""", inactive.id)

        assertThrows<ConflictException>("a worker") { runBlocking { ProjectService.changeSiteManager(boss, id, request(created, worker)) } }
        assertThrows<ConflictException>("not a member") { runBlocking { ProjectService.changeSiteManager(boss, id, request(created, outsider)) } }
        assertThrows<ConflictException>("no ČKAIT number") { runBlocking { ProjectService.changeSiteManager(boss, id, request(created, noCkait)) } }
        assertThrows<ConflictException>("deactivated") { runBlocking { ProjectService.changeSiteManager(boss, id, request(created, inactive)) } }
        assertThrows<ConflictException>("the same person") { runBlocking { ProjectService.changeSiteManager(boss, id, request(created, boss)) } }
        assertEquals(boss.id, siteManagerOf(created.id))
        assertEquals(0, dsl.fetchCount(AUDIT_LOG, AUDIT_LOG.ACTION.eq("project.site_manager.change")))
    }

    @Test
    fun `only the manager of this project may replace the site manager`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = project(boss)
        val id = UUID.fromString(created.id)
        addMember(id, deputy, Role.BOSS)
        val worker = createTestUser(role = Role.WORKER).also { addMember(id, it, Role.WORKER) }
        val inspector = createTestUser(role = Role.INSPECTOR).also { addMember(id, it, Role.INSPECTOR) }
        val outsider = createTestUser(role = Role.BOSS)
        val admin = createTestUser(role = Role.WORKER, isAdmin = true)

        for (person in listOf(worker, inspector, outsider, admin)) {
            assertThrows<ForbiddenException>("${person.role} admin=${person.isAdmin}") {
                runBlocking { ProjectService.changeSiteManager(person, id, request(created, deputy)) }
            }
        }
        assertEquals(boss.id, siteManagerOf(created.id))
    }

    @Test
    fun `the version is required, and somebody else's change is not overwritten`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = project(boss)
        val id = UUID.fromString(created.id)
        addMember(id, deputy, Role.BOSS)

        assertThrows<IllegalArgumentException> { runBlocking { ProjectService.changeSiteManager(boss, id, SiteManagerChangeRequest(deputy.id.toString(), null, null)) } }
        // The identification was changed meanwhile.
        ProjectService.updateProject(boss, id, created.copy(name = "Přejmenováno"))
        assertThrows<StaleVersionException> { runBlocking { ProjectService.changeSiteManager(boss, id, request(created, deputy)) } }
        assertEquals(boss.id, siteManagerOf(created.id))
    }

    @Test
    fun `an edit loaded before the site manager was replaced is stale, not a conflict about the site manager`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = project(boss)
        val id = UUID.fromString(created.id)
        addMember(id, deputy, Role.BOSS)

        ProjectService.changeSiteManager(boss, id, request(created, deputy))

        // The form still carries the previous site manager and the previous version.
        assertThrows<StaleVersionException> { runBlocking { ProjectService.updateProject(boss, id, created.copy(name = "Přejmenováno")) } }
        assertEquals(deputy.id, siteManagerOf(created.id))
    }

    @Test
    fun `the protection of the site manager moves to the new one`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = project(boss)
        val id = UUID.fromString(created.id)
        addMember(id, deputy, Role.BOSS)

        // Before: the site manager cannot be removed, the deputy can.
        assertThrows<ConflictException> { runBlocking { ProjectMemberService.removeMember(deputy, id, boss.id) } }

        ProjectService.changeSiteManager(boss, id, request(created, deputy))

        // After: the new site manager is protected, the previous one is an ordinary manager.
        assertThrows<ConflictException> { runBlocking { ProjectMemberService.removeMember(boss, id, deputy.id) } }
        ProjectMemberService.removeMember(deputy, id, boss.id)
        assertEquals(0, dsl.fetchCount(PROJECT_MEMBERS, PROJECT_MEMBERS.PROJECTID.eq(id).and(PROJECT_MEMBERS.USERID.eq(boss.id))))
    }

    @Test
    fun `the entry PDF names the current site manager`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS, displayName = "Původní Vedoucí")
        val deputy = createTestUser(role = Role.BOSS, displayName = "Nový Vedoucí")
        val created = project(boss)
        val id = UUID.fromString(created.id)
        addMember(id, deputy, Role.BOSS)
        val report = DailyReportService.createReport(boss, id, "2026-09-28", workDescription = "Betonáž")

        var data = ""
        PdfExportService.compiler = TypstCompiler { dir, _, pdfFile ->
            data = File(dir, "data.json").readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }
        fun row(): String {
            runBlocking { PdfExportService.generateReportPdf(dsl, UUID.fromString(report.id)) }
            return Json.parseToJsonElement(data).jsonObject["projectInfo"]!!.jsonArray
                .first { it.jsonObject["label"]!!.jsonPrimitive.content == "Stavbyvedoucí" }.jsonObject["value"]!!.jsonPrimitive.content
        }

        assertTrue(row().startsWith("Původní Vedoucí"), row())
        ProjectService.changeSiteManager(boss, id, request(created, deputy))
        assertTrue(row().startsWith("Nový Vedoucí"), row())
    }
}
