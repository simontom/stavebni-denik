package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import javax.imageio.ImageIO

/**
 * The project of an audit row is part of its hash, so every change that writes a row has to name the right one: this runs
 * every kind of change of the application (not a handful) through its service, in two projects, and checks `project_id` of
 * every row it wrote against the project that the changed record belongs to **as the database says it** (not as the rule in
 * [AuditProject] works it out, so a wrong or a missing rule fails here).
 *
 * A change that is added later has to be added here: the source is searched for every audit action there is, and one that this
 * test did not run fails it.
 */
class AuditProjectRowsTest : BaseIntegrationTest() {

    private fun jpeg(): ByteArray {
        val out = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(200, 150, BufferedImage.TYPE_INT_RGB), "jpeg", out)
        return out.toByteArray()
    }

    private fun projectDto(manager: cz.stavebni.denik.domain.SessionUser, name: String) = ProjectDto(
        id = "", name = name, address = "Adresa", cadastralArea = "Území", parcelNumbers = "1",
        builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = manager.id.toString(),
    )

    /** The project that the record an audit row is about belongs to, from the tables themselves. */
    private fun projectOfTheRecord(entityType: String, entityId: String): UUID? {
        val id = UUID.fromString(entityId)
        return when (entityType) {
            "project" -> id
            "report" -> dsl.select(DAILY_REPORTS.PROJECTID).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(id)).fetchSingle().value1()
            "photo" -> dsl.select(DAILY_REPORTS.PROJECTID).from(PHOTOS).join(DAILY_REPORTS).on(DAILY_REPORTS.ID.eq(PHOTOS.REPORTID))
                .where(PHOTOS.ID.eq(id)).fetchSingle().value1()
            "siteHandover" -> dsl.select(SITE_HANDOVERS.PROJECTID).from(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(id)).fetchSingle().value1()
            "authorizedPerson" -> dsl.select(AUTHORIZED_PERSONS.PROJECTID).from(AUTHORIZED_PERSONS).where(AUTHORIZED_PERSONS.ID.eq(id)).fetchSingle().value1()
            else -> fail("an audit row of the type '$entityType' that this test does not know")
        }
    }

    @Test
    fun `every audit row of a project names that project, whatever kind of change wrote it`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val inspector = createTestUser(role = Role.INSPECTOR)
        val worker = createTestUser(role = Role.WORKER)
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)

        // Project P: every kind of change there is.
        val p = ProjectService.createProject(boss, projectDto(boss, "P"))
        val pId = UUID.fromString(p.id)
        ProjectService.updateProject(boss, pId, p.copy(address = "Nová 1, Brno"))
        ProjectMemberService.addMember(boss, pId, AddMemberRequest(deputy.id.toString(), "BOSS"))
        ProjectMemberService.addMember(boss, pId, AddMemberRequest(inspector.id.toString(), "INSPECTOR"))
        ProjectMemberService.addMember(boss, pId, AddMemberRequest(worker.id.toString(), "WORKER"))
        ProjectMemberService.removeMember(boss, pId, worker.id)
        val current = ProjectService.getProject(dsl, boss, pId)
        ProjectService.changeSiteManager(boss, pId, SiteManagerChangeRequest(deputy.id.toString(), "Odchod", current.updatedAt))

        val draft = DailyReportService.createReport(boss, pId, "2026-09-28", workDescription = "Betonáž")
        DailyReportService.saveReport(boss, pId, "2026-09-28", DailyReportService.ReportInput(workDescription = "Betonáž stropu"))
        val keptPhoto = PhotoService.uploadPhoto(boss, UUID.fromString(draft.id), jpeg(), "image/jpeg", "a.jpg")
        val removedPhoto = PhotoService.uploadPhoto(boss, UUID.fromString(draft.id), jpeg(), "image/jpeg", "b.jpg")
        PhotoService.deletePhoto(boss, UUID.fromString(removedPhoto.id.toString()))
        DailyReportService.signReport(boss, UUID.fromString(draft.id))
        DailyReportService.acknowledgeReport(inspector, UUID.fromString(draft.id))
        AddendumService.create(boss, UUID.fromString(draft.id), CreateAddendumRequest("Oprava"))
        RemarkService.create(inspector, UUID.fromString(draft.id), CreateRemarkRequest(text = "Bez závad"))

        fun handover(project: UUID) = SiteHandoverDto(projectId = project.toString(), type = "PROTOCOL", date = "2026-09-28", participants = "Novák")
        val kept = SiteHandoverService.createHandover(boss, handover(pId))
        SiteHandoverService.updateHandover(boss, UUID.fromString(kept.id), handover(pId).copy(type = "ZMĚNA"))
        SiteHandoverService.signHandover(boss, UUID.fromString(kept.id))
        val removed = SiteHandoverService.createHandover(boss, handover(pId))
        SiteHandoverService.deleteHandover(boss, UUID.fromString(removed.id))

        val person = AuthorizedPersonService.create(boss, pId, CreateAuthorizedPersonRequest(name = "Ing. Dozor", company = "TDS"))
        AuthorizedPersonService.revoke(boss, UUID.fromString(person.id))

        // Project Q: a few of the same, so that the rows of one project cannot be taken for the rows of another.
        val q = ProjectService.createProject(boss, projectDto(boss, "Q"))
        val qId = UUID.fromString(q.id)
        DailyReportService.createReport(boss, qId, "2026-09-28")
        SiteHandoverService.createHandover(boss, handover(qId))
        AuthorizedPersonService.create(boss, qId, CreateAuthorizedPersonRequest(name = "Ing. Jiný"))

        // Users belong to no project.
        UserService.createUser(admin, CreateUserRequest(nickname = "novy.clovek", displayName = "Nový Člověk"))

        val seen = mutableSetOf<String>()
        val projects = mutableSetOf<UUID>()
        for (row in dsl.selectFrom(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch()) {
            val action = row.get(AUDIT_LOG.ACTION)!!
            seen += action
            val expected = if (action.startsWith("user.")) null else projectOfTheRecord(row.get(AUDIT_LOG.ENTITY_TYPE)!!, row.get(AUDIT_LOG.ENTITY_ID)!!)
            assertEquals(expected, row.get(AUDIT_LOG.PROJECT_ID), "the project of row ${row.get(AUDIT_LOG.ID)} ($action)")
            if (!action.startsWith("user.")) {
                assertNotNull(row.get(AUDIT_LOG.PROJECT_ID), "$action belongs to a project")
                projects += row.get(AUDIT_LOG.PROJECT_ID)!!
            }
        }
        assertEquals(setOf(pId, qId), projects, "rows of both projects")
        assertNotNull(keptPhoto)
        assertTrue(AuditService.verifyChain(dsl).ok, "and the verification, which works the project out again from every payload, agrees")

        // Every kind of change in the application was run above.
        val inTheCode = auditActionsInTheSource().filterNot { it.startsWith("user.") }.toSortedSet()
        assertTrue(inTheCode.isNotEmpty(), "the source was read")
        assertEquals(
            emptySet<String>(), inTheCode - seen,
            "an audit action that this test did not run (add it to the scenario above, and make sure that AuditProject names its project)",
        )
    }

    /** Every `action = "..."` that a service gives its audit row. */
    private fun auditActionsInTheSource(): Set<String> {
        val root = listOf(File("src/main/kotlin"), File("backend/src/main/kotlin")).firstOrNull { it.isDirectory }
            ?: fail("the source of the application was not found from ${File(".").absolutePath}")
        val pattern = Regex("""action\s*=\s*"([A-Za-z_.]+)"""")
        return root.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .flatMap { file -> pattern.findAll(file.readText()).map { it.groupValues[1] } }
            .toSet()
    }
}
