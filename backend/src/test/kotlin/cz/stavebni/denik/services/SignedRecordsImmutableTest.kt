package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.StaleVersionException
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVER_SIGNATURES
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
        addMember(projectId, worker)
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

    private fun auditRows(action: String) = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.asc()).fetch()

    // --- the database ---------------------------------------------------------------------------

    @Test
    fun `the database refuses to change, delete or add photos to a signed report, whatever column`() = runBlocking<Unit> {
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

        // Not even the updated-at stamp may move: since V11 a signed daily report is immutable as a whole (the acknowledgements
        // live in a table of their own).
        assertThrows<DataAccessException> { dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.UPDATEDAT, OffsetDateTime.now()).where(DAILY_REPORTS.ID.eq(reportId)).execute() }

        val row = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()!!
        assertEquals("Upraveno", row.workdescription)
        assertNotNull(row.lockedat)
        assertEquals(1, dsl.fetchCount(PHOTOS))
    }

    @Test
    fun `the database refuses to change or delete a handover protocol that a party signed`() = runBlocking<Unit> {
        val s = site()
        val handover = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())
        val id = handover.uuid

        dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "před podpisem").where(SITE_HANDOVERS.ID.eq(id)).execute()
        signHandover(s.boss, SiteHandoverService.getHandover(dsl, s.boss, id)!!)

        assertThrows<DataAccessException> { dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "po podpisu").where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException> { dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.DELETEDAT, OffsetDateTime.now()).where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException> { dsl.deleteFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertEquals("před podpisem", dsl.selectFrom(SITE_HANDOVERS).fetchOne()!!.notes)
    }

    // --- requests that arrive together ----------------------------------------------------------
    //
    // Every write of the application takes ONE advisory lock first (AuditService.auditedWrite), so the requests below are served one
    // after the other whatever the threads do. What they show are the DECISIONS of the application when requests arrive together
    // (who is told what), not how the database behaves when two writers meet: SiteHandoverSignaturesDbTest does that with two
    // plain connections that take no lock of the application's.

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
    fun `two requests that arrive together to sign the same side of a handover give one signature and one conflict`() = runBlocking<Unit> {
        val s = site()
        val handover = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())
        val second = createTestUser(role = Role.BOSS)
        addMember(s.projectId, second)

        val results = coroutineScope {
            listOf(s.boss, second).map { signer -> async(Dispatchers.IO) { runCatching { signHandover(signer, handover) } } }.awaitAll()
        }

        assertEquals(1, results.count { it.isSuccess }, results.toString())
        assertTrue(results.single { it.isFailure }.exceptionOrNull() is ConflictException, results.toString())
        assertEquals(1, auditRows("siteHandover.sign").size)
        assertEquals(1, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))
        val signer = dsl.selectFrom(SITE_HANDOVER_SIGNATURES).fetchOne()!!.signedbyid
        assertTrue(signer == s.boss.id || signer == second.id)
    }

    @Test
    fun `the two parties whose requests arrive together both get their signature`() = runBlocking<Unit> {
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR)
        addMember(s.projectId, investor)
        val handover = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())

        val results = coroutineScope {
            listOf(s.boss, investor).map { signer -> async(Dispatchers.IO) { runCatching { signHandover(signer, handover) } } }.awaitAll()
        }

        assertTrue(results.all { it.isSuccess }, results.toString())
        assertEquals(setOf("CONTRACTOR", "CLIENT"), dsl.selectFrom(SITE_HANDOVER_SIGNATURES).fetch().map { it.side }.toSet())
        assertEquals(1, dsl.selectFrom(SITE_HANDOVER_SIGNATURES).fetch().map { it.contenthash }.toSet().size, "both signed the same content")
        assertEquals(2, auditRows("siteHandover.sign").size)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a change and a signature that arrive together are not both accepted, and a change never follows a signature`() = runBlocking<Unit> {
        val s = site()
        val handover = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())

        // Both were prepared from the same version: whichever is served first moves or freezes it, and the other is refused.
        val results = coroutineScope {
            val update = async(Dispatchers.IO) { runCatching { SiteHandoverService.updateHandover(s.boss, handover.uuid, handover.asInput(type = "LATE CHANGE")) } }
            val sign = async(Dispatchers.IO) { runCatching { signHandover(s.boss, handover) } }
            listOf(update, sign).awaitAll()
        }

        assertEquals(1, results.count { it.isSuccess }, "exactly one of them goes through: $results")
        val final = dsl.selectFrom(SITE_HANDOVERS).fetchOne()!!
        if (results[1].isSuccess) {
            // The signature came first: it froze the protocol, and the change that was behind it is refused.
            assertEquals("PROTOCOL", final.type)
            assertEquals(0, auditRows("siteHandover.update").size)
            assertTrue(results[0].exceptionOrNull() is ConflictException, "refused because the protocol is signed: ${results[0]}")
        } else {
            // The change came first and moved the version, so the signature of the version that was seen is refused.
            assertEquals("LATE CHANGE", final.type)
            assertEquals(0, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))
            assertTrue(results[1].exceptionOrNull() is StaleVersionException, "refused because the version moved: ${results[1]}")
        }
    }

    // --- the audit trail ------------------------------------------------------------------------

    @Test
    fun `handover create, update, both signatures and delete are audited with the entity id, before and after`() = runBlocking<Unit> {
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR, displayName = "Marie Stavebníková")
        addMember(s.projectId, investor)
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())
        val updated = SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(type = "ZMĚNA"))
        val byContractor = signHandover(s.boss, updated)
        val complete = signHandover(investor, byContractor)
        val removed = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Zrušený"))
        SiteHandoverService.deleteHandover(s.boss, removed.uuid)

        val create = auditRows("siteHandover.create").first()
        assertEquals(created.id, create.get(AUDIT_LOG.ENTITY_ID))
        assertNull(create.auditBeforeText())
        val update = auditRows("siteHandover.update").single()
        assertEquals("PROTOCOL", Json.parseToJsonElement(update.auditBeforeText()!!).jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("ZMĚNA", Json.parseToJsonElement(update.auditAfterText()!!).jsonObject["type"]!!.jsonPrimitive.content)

        val signs = auditRows("siteHandover.sign")
        assertEquals(2, signs.size, "one row for each signature")
        for (sign in signs) assertEquals(created.id, sign.get(AUDIT_LOG.ENTITY_ID))
        val beforeFirst = Json.parseToJsonElement(signs[0].auditBeforeText()!!).jsonObject
        val afterFirst = Json.parseToJsonElement(signs[0].auditAfterText()!!).jsonObject
        assertEquals("null", beforeFirst["contractorSignature"].toString())
        val contractor = afterFirst["contractorSignature"]!!.jsonObject
        assertEquals(s.boss.id.toString(), contractor["signedById"]!!.jsonPrimitive.content)
        assertEquals("BOSS", contractor["signerRole"]!!.jsonPrimitive.content)
        assertEquals(complete.contractorSignature!!.signatureHash, contractor["signatureHash"]!!.jsonPrimitive.content)
        assertEquals("null", afterFirst["clientSignature"].toString(), "the first row shows only the contractor's signature")
        val afterSecond = Json.parseToJsonElement(signs[1].auditAfterText()!!).jsonObject
        assertEquals("Marie Stavebníková", afterSecond["clientSignature"]!!.jsonObject["signerName"]!!.jsonPrimitive.content)
        assertEquals(complete.clientSignature!!.contentHash, afterSecond["clientSignature"]!!.jsonObject["contentHash"]!!.jsonPrimitive.content)

        val delete = auditRows("siteHandover.delete").single()
        assertEquals(removed.id, delete.get(AUDIT_LOG.ENTITY_ID))
        assertNotEquals("null", Json.parseToJsonElement(delete.auditAfterText()!!).jsonObject["deletedAt"].toString())

        // (That no password is in any row is checked where the password exists: SiteHandoverRoutesTest signs with a known one.)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }
}
