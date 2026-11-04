package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.UUID
import javax.imageio.ImageIO

/**
 * What removing a photo does next to the other writes of an entry (backlog A4): it is decided on the locked entry, so it cannot meet a
 * signature half way, and a signature made after it covers exactly the photos that are left.
 */
class PhotoRemovalTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val worker: SessionUser, val projectId: UUID)

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Removal Project", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        addMember(projectId, worker)
        return Site(boss, worker, projectId)
    }

    private fun jpeg(): ByteArray {
        val out = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(200, 150, BufferedImage.TYPE_INT_RGB), "jpeg", out)
        return out.toByteArray()
    }

    private fun auditRows(action: String) = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.asc()).fetch()

    /**
     * What this test proves, and what it does not: **every outcome is sound, whichever order wins** (a signed entry never loses a photo, a signature
     * always covers exactly the photos the entry has, the audit chain verifies). It does **not** prove that both orders were seen: the two writes meet
     * at the audit lock first and the entry row second, so they are served strictly one after the other, and which one goes first is the scheduler's
     * choice, which a test cannot force and must not assert (a count of both orders would be a flaky test). Each order is covered on its own, with
     * no timing, by the two tests that follow: `signed first then removal is refused with a conflict and nothing changes` and
     * `removed first then signed the signature covers the photos that are left and the check says so`.
     */
    @Test
    fun `a removal and a signature that arrive together end as removed then signed or signed and refused, never a signed entry that loses a photo`() = runBlocking<Unit> {
        val s = site()
        var removedFirst = 0
        var signedFirst = 0

        // The pair is started together several times; whichever order comes up must be a sound one (the counts below are only in the failure message).
        for (day in 1..8) {
            val report = DailyReportService.createReport(s.boss, s.projectId, "2026-09-%02d".format(day), workDescription = "Betonáž $day")
            val reportId = UUID.fromString(report.id)
            val doomed = PhotoService.uploadPhoto(s.worker, reportId, jpeg(), "image/jpeg", "a.jpg").id
            val kept = PhotoService.uploadPhoto(s.boss, reportId, jpeg(), "image/jpeg", "b.jpg").id

            val (removal, signature) = coroutineScope {
                val remove = async(Dispatchers.IO) { runCatching { PhotoService.deletePhoto(s.boss, doomed) } }
                val sign = async(Dispatchers.IO) { runCatching { lockUnchecked(s.boss, reportId) } }
                listOf(remove, sign).awaitAll()
            }

            assertTrue(signature.isSuccess, "the signing goes through whichever comes first: $signature")
            val photosLeft = dsl.select(PHOTOS.ID).from(PHOTOS).where(PHOTOS.REPORTID.eq(reportId)).fetch(PHOTOS.ID).toSet()
            val check = ReportSignature.check(dsl, reportId)
            // The signature is of the photos the entry has: if one went after it, the check would find the entry changed.
            assertEquals(true, check.contentMatches, "day $day: the signature covers exactly the photos that are on the entry ($removal)")
            if (removal.isSuccess) {
                removedFirst++
                assertEquals(setOf(kept), photosLeft, "removed, then signed without it")
                assertTrue(auditRows("photo.delete").last().get(AUDIT_LOG.ID)!! < auditRows("report.lock").last().get(AUDIT_LOG.ID)!!, "the removal precedes the signature")
            } else {
                signedFirst++
                assertTrue(removal.exceptionOrNull() is ConflictException, "refused because the entry is signed: ${removal.exceptionOrNull()}")
                assertEquals(setOf(doomed, kept), photosLeft, "signed, and the photo it covers is still there")
            }
        }
        // Whatever happened, the audit chain is whole and every signature is of a state that existed.
        assertTrue(AuditService.verifyChain(dsl).ok)
        assertEquals(removedFirst, auditRows("photo.delete").size, "$removedFirst removals and $signedFirst refusals")
    }

    @Test
    fun `signed first then removal is refused with a conflict and nothing changes`() = runBlocking<Unit> {
        val s = site()
        val report = DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Text")
        val reportId = UUID.fromString(report.id)
        val photo = PhotoService.uploadPhoto(s.worker, reportId, jpeg(), "image/jpeg", "a.jpg").id
        lockUnchecked(s.boss, reportId)

        val refusal = assertThrows<ConflictException> { PhotoService.deletePhoto(s.boss, photo) }
        assertTrue(refusal.message!!.contains("podepsan"), "the message is the person's: ${refusal.message}")
        assertEquals(1, dsl.fetchCount(PHOTOS))
        assertEquals(true, ReportSignature.check(dsl, reportId).contentMatches)
    }

    @Test
    fun `removed first then signed the signature covers the photos that are left and the check says so`() = runBlocking<Unit> {
        val s = site()
        val report = DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Text")
        val reportId = UUID.fromString(report.id)
        val doomed = PhotoService.uploadPhoto(s.worker, reportId, jpeg(), "image/jpeg", "a.jpg").id
        val kept = PhotoService.uploadPhoto(s.worker, reportId, jpeg(), "image/jpeg", "b.jpg").id

        PhotoService.deletePhoto(s.worker, doomed)
        lockUnchecked(s.boss, reportId)

        val signed = DailyReportService.getReport(s.projectId, reportId.toString(), s.boss)!!
        assertEquals(listOf(kept), signed.photos.map { it.id })
        val record = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()!!
        val content = ReportSignature.content(dsl, record, record.signedat!!, record.get(DAILY_REPORTS.SIGNEDBYID)!!)
        val covered = content["photos"]!!.toString()
        assertTrue(covered.contains(kept.toString()), "the photo that is left is covered: $covered")
        assertFalse(covered.contains(doomed.toString()), "the one that was removed is not: $covered")
        assertEquals(true, ReportSignature.check(dsl, reportId).contentMatches)
    }

    @Test
    fun `an unknown photo is not found, and a person who may not remove it is told so before anything changes`() = runBlocking<Unit> {
        val s = site()
        val report = DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Text")
        val photo = PhotoService.uploadPhoto(s.boss, UUID.fromString(report.id), jpeg(), "image/jpeg", "a.jpg").id

        assertThrows<NotFoundException> { PhotoService.deletePhoto(s.boss, UUID.randomUUID()) }
        assertThrows<ForbiddenException> { PhotoService.deletePhoto(s.worker, photo) }
        assertThrows<NotFoundException> { PhotoService.deletePhoto(createTestUser(role = Role.BOSS), photo) }

        assertEquals(1, dsl.fetchCount(PHOTOS))
        assertEquals(0, auditRows("photo.delete").size)
    }

    @Test
    fun `the audit row of a removal holds the photo as it was stored and verifies in the chain`() = runBlocking<Unit> {
        val s = site()
        val report = DailyReportService.createReport(s.boss, s.projectId, "2026-09-28", workDescription = "Text")
        val photo = PhotoService.uploadPhoto(s.worker, UUID.fromString(report.id), jpeg(), "image/jpeg", "a.jpg").id
        val uploaded = Json.parseToJsonElement(auditRows("photo.upload").single().auditAfterText()!!).jsonObject

        PhotoService.deletePhoto(s.boss, photo)

        val row = auditRows("photo.delete").single()
        val before = Json.parseToJsonElement(row.auditBeforeText()!!).jsonObject
        assertEquals(uploaded["sha256Original"], before["sha256Original"], "the hashes of the two files are the ones recorded at upload")
        assertEquals(uploaded["sha256Thumbnail"], before["sha256Thumbnail"])
        assertEquals(s.worker.id.toString(), before["uploadedById"]!!.jsonPrimitive.content)
        assertNull(row.auditAfterText())
        assertTrue(AuditService.verifyChain(dsl).ok)
    }
}
