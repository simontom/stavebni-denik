package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.UUID
import javax.imageio.ImageIO

/**
 * An app administrator may open every project to read it, but is not a member of it: writing (photos, site handovers)
 * needs real membership. Joining a project as an administrator is the audited way in (decision D1).
 */
class NonMemberAdminWritesTest : BaseIntegrationTest() {

    private class Site(val owner: SessionUser, val projectId: UUID, val reportId: UUID)

    private suspend fun site(): Site {
        val owner = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = "Admin Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = owner.id.toString()
            )
        )
        val projectId = UUID.fromString(project.id)
        val report = DailyReportService.createReport(owner, projectId, "2026-09-28")
        return Site(owner, projectId, UUID.fromString(report.id))
    }

    private fun jpeg(): ByteArray {
        val image = BufferedImage(200, 150, BufferedImage.TYPE_INT_RGB)
        val out = ByteArrayOutputStream()
        ImageIO.write(image, "jpeg", out)
        return out.toByteArray()
    }

    private fun handoverDto(projectId: UUID) =
        SiteHandoverDto(projectId = projectId.toString(), type = "PROTOCOL", date = "2026-09-28", participants = "Novák, Dvořák")

    private fun photoFiles(): Int {
        val dir = AppConfig.uploadsDir.resolve("photos")
        return if (Files.isDirectory(dir)) Files.list(dir).use { it.count().toInt() } else 0
    }

    private fun auditRows(action: String) = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.asc()).fetch()

    // --- handovers -----------------------------------------------------------------------------

    @Test
    fun `a non-member app admin can read handovers but not write them`() = runBlocking<Unit> {
        val s = site()
        val handover = SiteHandoverService.createHandover(s.owner, handoverDto(s.projectId))
        val handoverId = UUID.fromString(handover.id)

        for (admin in listOf(createTestUser(role = Role.BOSS, isAdmin = true), createTestUser(role = Role.WORKER, isAdmin = true))) {
            // Reading works for every admin ...
            assertNotNull(SiteHandoverService.getHandover(dsl, admin, handoverId))
            assertEquals(1, SiteHandoverService.listHandovers(dsl, admin, s.projectId).size)
            // ... writing does not.
            assertThrows<ForbiddenException> { SiteHandoverService.createHandover(admin, handoverDto(s.projectId)) }
            assertThrows<ForbiddenException> { SiteHandoverService.updateHandover(admin, handoverId, handoverDto(s.projectId).copy(type = "CHANGED")) }
            assertThrows<ForbiddenException> { SiteHandoverService.signHandover(admin, handoverId) }
            assertThrows<ForbiddenException> { SiteHandoverService.deleteHandover(admin, handoverId) }
        }

        val row = dsl.selectFrom(SITE_HANDOVERS).fetchOne()!!
        assertEquals(1, dsl.fetchCount(SITE_HANDOVERS), "nothing was created")
        assertEquals("PROTOCOL", row.type, "nothing was changed")
        assertNull(row.signedat, "nothing was signed")
        assertNull(row.deletedat, "nothing was deleted")
    }

    @Test
    fun `a member can do all of it`() = runBlocking<Unit> {
        val s = site()
        val handover = SiteHandoverService.createHandover(s.owner, handoverDto(s.projectId))
        val id = UUID.fromString(handover.id)

        val updated = SiteHandoverService.updateHandover(s.owner, id, handoverDto(s.projectId).copy(type = "CHANGED"))
        val signed = SiteHandoverService.signHandover(s.owner, id)

        assertEquals("CHANGED", updated.type)
        assertNotNull(signed.signedAt)
    }

    // --- photos --------------------------------------------------------------------------------

    @Test
    fun `a non-member app admin cannot upload or remove a photo, and nothing reaches the disk`() = runBlocking<Unit> {
        val s = site()
        val photo = PhotoService.uploadPhoto(s.owner, s.reportId, jpeg(), "image/jpeg", "a.jpg")
        val filesBefore = photoFiles()

        for (admin in listOf(createTestUser(role = Role.BOSS, isAdmin = true), createTestUser(role = Role.WORKER, isAdmin = true))) {
            assertThrows<ForbiddenException> { PhotoService.uploadPhoto(admin, s.reportId, jpeg(), "image/jpeg", "b.jpg") }
            assertThrows<ForbiddenException> { PhotoService.deletePhoto(admin, photo.id) }
        }

        assertEquals(1, dsl.fetchCount(PHOTOS), "no photo was added")
        assertNull(dsl.selectFrom(PHOTOS).fetchOne()!!.deletedat, "the photo was not removed")
        assertEquals(filesBefore, photoFiles(), "a refused upload must not even be decoded or written")
    }

    @Test
    fun `an upload is audited with the photo, the report and the hashes of both files`() = runBlocking<Unit> {
        val s = site()

        val photo = PhotoService.uploadPhoto(s.owner, s.reportId, jpeg(), "image/jpeg", "a.jpg")

        val row = auditRows("photo.upload").single()
        assertEquals(photo.id.toString(), row.get(AUDIT_LOG.ENTITY_ID))
        val after = Json.parseToJsonElement(row.get(AUDIT_LOG.AFTER)!!.data()).jsonObject
        assertEquals(s.reportId.toString(), after["reportId"]!!.jsonPrimitive.content)
        assertEquals(64, after["sha256Original"]!!.jsonPrimitive.content.length)
        assertEquals(64, after["sha256Thumbnail"]!!.jsonPrimitive.content.length)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    // --- joining a project as an administrator ---------------------------------------------------

    @Test
    fun `an administrator joins a project the audited way and is then a member`() = runBlocking<Unit> {
        val s = site()
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        assertThrows<ForbiddenException> { SiteHandoverService.createHandover(admin, handoverDto(s.projectId)) }

        ProjectMemberService.addMember(admin, s.projectId, AddMemberRequest(userId = admin.id.toString(), role = "BOSS"))

        assertNotNull(SiteHandoverService.createHandover(admin, handoverDto(s.projectId)), "as a member the administrator may write")
        val row = auditRows("project.member.add").single()
        assertEquals(s.projectId.toString(), row.get(AUDIT_LOG.ENTITY_ID))
        assertNull(row.get(AUDIT_LOG.BEFORE), "there was no membership before")
        val after = Json.parseToJsonElement(row.get(AUDIT_LOG.AFTER)!!.data()).jsonObject
        assertEquals(admin.id.toString(), after["userId"]!!.jsonPrimitive.content)
        assertEquals("BOSS", after["role"]!!.jsonPrimitive.content)
    }

    @Test
    fun `changing and removing a member is audited with the role before and after`() = runBlocking<Unit> {
        val s = site()
        val worker = createTestUser(role = Role.WORKER)
        ProjectMemberService.addMember(s.owner, s.projectId, AddMemberRequest(worker.id.toString(), "WORKER"))
        ProjectMemberService.addMember(s.owner, s.projectId, AddMemberRequest(worker.id.toString(), "INSPECTOR"))
        ProjectMemberService.removeMember(s.owner, s.projectId, worker.id)

        val adds = auditRows("project.member.add")
        val change = Json.parseToJsonElement(adds.last().get(AUDIT_LOG.BEFORE)!!.data()).jsonObject
        assertEquals("WORKER", change["role"]!!.jsonPrimitive.content)
        val removal = auditRows("project.member.remove").single()
        assertEquals("INSPECTOR", Json.parseToJsonElement(removal.get(AUDIT_LOG.BEFORE)!!.data()).jsonObject["role"]!!.jsonPrimitive.content)
        assertNull(removal.get(AUDIT_LOG.AFTER))
        assertEquals(0, dsl.fetchCount(PROJECT_MEMBERS, PROJECT_MEMBERS.USERID.eq(worker.id)))
    }

    // --- authorized persons --------------------------------------------------------------------

    @Test
    fun `authorized persons are audited, and revoking twice keeps the first revocation`() = runBlocking<Unit> {
        val s = site()
        val person = AuthorizedPersonService.create(s.owner, s.projectId, CreateAuthorizedPersonRequest(name = "Ing. Dozor", company = "TDS s.r.o."))
        val id = UUID.fromString(person.id)

        val createRow = auditRows("authorizedPerson.create").single()
        assertEquals(person.id, createRow.get(AUDIT_LOG.ENTITY_ID))
        assertEquals("Ing. Dozor", Json.parseToJsonElement(createRow.get(AUDIT_LOG.AFTER)!!.data()).jsonObject["name"]!!.jsonPrimitive.content)

        val revoked = AuthorizedPersonService.revoke(s.owner, id)
        val firstRevokedAt = dsl.selectFrom(AUTHORIZED_PERSONS).fetchOne()!!.revokedat
        assertNotNull(revoked.revokedAt)
        assertThrows<cz.stavebni.denik.domain.ConflictException> { AuthorizedPersonService.revoke(s.owner, id) }
        assertEquals(firstRevokedAt, dsl.selectFrom(AUTHORIZED_PERSONS).fetchOne()!!.revokedat, "the first revocation time is kept")
        assertEquals(1, auditRows("authorizedPerson.revoke").size, "the refused second revocation left no audit row")
    }
}
