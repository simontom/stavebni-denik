package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.time.OffsetDateTime
import java.util.Random
import java.util.UUID
import javax.imageio.ImageIO

/**
 * A signed record cannot change: not through the application (the decisions are made on rows locked FOR UPDATE), and not
 * through a path that forgot to check (migration V5 makes the database refuse it).
 */
class SignedRecordsImmutableTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val worker: SessionUser, val projectId: UUID)

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Immutable Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
            )
        )
        val projectId = UUID.fromString(project.id)
        dsl.insertInto(PROJECT_MEMBERS).set(PROJECT_MEMBERS.PROJECTID, projectId).set(PROJECT_MEMBERS.USERID, worker.id).execute()
        return Site(boss, worker, projectId)
    }

    private fun jpeg(width: Int = 200, height: Int = 150, noise: Boolean = false): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        if (noise) {
            val random = Random(7)
            for (y in 0 until height) for (x in 0 until width) image.setRGB(x, y, random.nextInt())
        }
        val out = ByteArrayOutputStream()
        ImageIO.write(image, "jpeg", out)
        return out.toByteArray()
    }

    private fun handoverDto(projectId: UUID) =
        SiteHandoverDto(projectId = projectId.toString(), type = "PROTOCOL", date = "2026-09-28", participants = "Novák")

    private fun auditRows(action: String) = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.asc()).fetch()

    // --- the database ---------------------------------------------------------------------------

    @Test
    fun `the database refuses to change, delete or add photos to a signed report, except for the acknowledgement`() = runBlocking<Unit> {
        val s = site()
        val report = DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Původní")
        val reportId = UUID.fromString(report.id)
        val photo = PhotoService.uploadPhoto(s.worker, reportId, jpeg(), "image/jpeg", "a.jpg")

        // Before signing everything is allowed.
        dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.WORKDESCRIPTION, "Upraveno").where(DAILY_REPORTS.ID.eq(reportId)).execute()
        DailyReportService.lockReport(s.boss, reportId)

        assertThrows<DataAccessException> {
            dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.WORKDESCRIPTION, "Přepsáno").where(DAILY_REPORTS.ID.eq(reportId)).execute()
        }
        assertThrows<DataAccessException> {
            dsl.update(DAILY_REPORTS).setNull(DAILY_REPORTS.LOCKEDAT).where(DAILY_REPORTS.ID.eq(reportId)).execute()
        }
        assertThrows<DataAccessException> { dsl.deleteFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).execute() }
        assertThrows<DataAccessException> {
            dsl.insertInto(PHOTOS)
                .set(PHOTOS.REPORTID, reportId).set(PHOTOS.PATHORIGINAL, "photos/x_orig.jpg").set(PHOTOS.PATHTHUMB, "photos/x_thumb.jpg")
                .set(PHOTOS.WIDTH, 1).set(PHOTOS.HEIGHT, 1).set(PHOTOS.BYTES, 1).set(PHOTOS.UPLOADEDBYID, s.worker.id).execute()
        }
        assertThrows<DataAccessException> { dsl.update(PHOTOS).set(PHOTOS.DELETEDAT, OffsetDateTime.now()).where(PHOTOS.ID.eq(photo.id)).execute() }
        assertThrows<DataAccessException> { dsl.deleteFrom(PHOTOS).where(PHOTOS.ID.eq(photo.id)).execute() }

        // What is still allowed: the acknowledgement.
        dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.ACKNOWLEDGEDAT, OffsetDateTime.now()).where(DAILY_REPORTS.ID.eq(reportId)).execute()

        val row = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()!!
        assertEquals("Upraveno", row.workdescription)
        assertNotNull(row.lockedat)
        assertEquals(1, dsl.fetchCount(PHOTOS))
    }

    @Test
    fun `the database refuses to change or delete a signed handover protocol`() = runBlocking<Unit> {
        val s = site()
        val handover = SiteHandoverService.createHandover(s.boss, handoverDto(s.projectId))
        val id = UUID.fromString(handover.id)

        dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "před podpisem").where(SITE_HANDOVERS.ID.eq(id)).execute()
        SiteHandoverService.signHandover(s.boss, id)

        assertThrows<DataAccessException> { dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "po podpisu").where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException> { dsl.update(SITE_HANDOVERS).setNull(SITE_HANDOVERS.SIGNEDAT).where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException> { dsl.deleteFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertEquals("před podpisem", dsl.selectFrom(SITE_HANDOVERS).fetchOne()!!.notes)
    }

    // --- races ----------------------------------------------------------------------------------

    @Test
    fun `a photo that is still being processed when the report is signed is refused, not added`() = runBlocking<Unit> {
        val s = site()
        val report = DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Text")
        val reportId = UUID.fromString(report.id)
        // A large noisy image takes a while to decode and encode, outside any lock.
        val big = jpeg(2800, 2200, noise = true)

        val outcomes = coroutineScope {
            val upload = async(Dispatchers.IO) { runCatching { PhotoService.uploadPhoto(s.worker, reportId, big, "image/jpeg", "big.jpg") } }
            delay(150)
            val sign = async(Dispatchers.IO) { runCatching { DailyReportService.lockReport(s.boss, reportId) } }
            listOf(upload, sign).awaitAll()
        }
        val upload = outcomes[0]
        assertTrue(outcomes[1].isSuccess, "the signing itself succeeds: ${outcomes[1]}")

        val uploadAudit = auditRows("photo.upload")
        val signAudit = auditRows("report.lock")
        assertEquals(1, signAudit.size)
        if (upload.isSuccess) {
            // The photo went in first: its audit row precedes the signature.
            assertEquals(1, dsl.fetchCount(PHOTOS))
            assertTrue(uploadAudit.single().get(AUDIT_LOG.ID)!! < signAudit.single().get(AUDIT_LOG.ID)!!, "a photo may not follow the signature")
        } else {
            assertTrue(upload.exceptionOrNull() is ForbiddenException, "refused because the report is signed: ${upload.exceptionOrNull()}")
            assertEquals(0, dsl.fetchCount(PHOTOS))
            assertEquals(0, uploadAudit.size)
        }
    }

    @Test
    fun `two requests signing the same handover give one signature and one conflict`() = runBlocking<Unit> {
        val s = site()
        val id = UUID.fromString(SiteHandoverService.createHandover(s.boss, handoverDto(s.projectId)).id)
        val second = createTestUser(role = Role.BOSS)
        dsl.insertInto(PROJECT_MEMBERS).set(PROJECT_MEMBERS.PROJECTID, s.projectId).set(PROJECT_MEMBERS.USERID, second.id).execute()

        val results = coroutineScope {
            listOf(s.boss, second).map { signer -> async(Dispatchers.IO) { runCatching { SiteHandoverService.signHandover(signer, id) } } }.awaitAll()
        }

        assertEquals(1, results.count { it.isSuccess }, results.toString())
        assertTrue(results.single { it.isFailure }.exceptionOrNull() is IllegalStateException)
        assertEquals(1, auditRows("siteHandover.sign").size)
        val signer = dsl.selectFrom(SITE_HANDOVERS).fetchOne()!!.signedbyid
        assertTrue(signer == s.boss.id || signer == second.id)
    }

    @Test
    fun `a handover change that races with the signature cannot land after it`() = runBlocking<Unit> {
        val s = site()
        val id = UUID.fromString(SiteHandoverService.createHandover(s.boss, handoverDto(s.projectId)).id)

        val results = coroutineScope {
            val update = async(Dispatchers.IO) { runCatching { SiteHandoverService.updateHandover(s.boss, id, handoverDto(s.projectId).copy(type = "LATE CHANGE")) } }
            val sign = async(Dispatchers.IO) { runCatching { SiteHandoverService.signHandover(s.boss, id) } }
            listOf(update, sign).awaitAll()
        }

        assertTrue(results[1].isSuccess, "signing succeeds: ${results[1]}")
        val signId = auditRows("siteHandover.sign").single().get(AUDIT_LOG.ID)!!
        for (update in auditRows("siteHandover.update")) {
            assertTrue(update.get(AUDIT_LOG.ID)!! < signId, "no change after the signature")
        }
        val final = dsl.selectFrom(SITE_HANDOVERS).fetchOne()!!
        assertEquals(if (results[0].isSuccess) "LATE CHANGE" else "PROTOCOL", final.type)
        assertNotNull(final.signedat)
    }

    // --- the audit trail ------------------------------------------------------------------------

    @Test
    fun `handover create, update and sign are audited with the entity id and before and after`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.boss, handoverDto(s.projectId))
        val id = UUID.fromString(created.id)
        SiteHandoverService.updateHandover(s.boss, id, handoverDto(s.projectId).copy(type = "ZMĚNA"))
        SiteHandoverService.signHandover(s.boss, id)

        val create = auditRows("siteHandover.create").single()
        assertEquals(created.id, create.get(AUDIT_LOG.ENTITY_ID))
        assertNull(create.get(AUDIT_LOG.BEFORE))
        val update = auditRows("siteHandover.update").single()
        assertEquals("PROTOCOL", Json.parseToJsonElement(update.get(AUDIT_LOG.BEFORE)!!.data()).jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("ZMĚNA", Json.parseToJsonElement(update.get(AUDIT_LOG.AFTER)!!.data()).jsonObject["type"]!!.jsonPrimitive.content)
        val sign = auditRows("siteHandover.sign").single()
        assertEquals(created.id, sign.get(AUDIT_LOG.ENTITY_ID))
        assertEquals("null", Json.parseToJsonElement(sign.get(AUDIT_LOG.BEFORE)!!.data()).jsonObject["signedAt"].toString())
        assertNotEquals("null", Json.parseToJsonElement(sign.get(AUDIT_LOG.AFTER)!!.data()).jsonObject["signedAt"].toString())
        assertTrue(AuditService.verifyChain(dsl).ok)
    }
}
