package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.AuditService
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.PhotoService
import cz.stavebni.denik.services.PhotoStorage
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.auditAfterText
import cz.stavebni.denik.services.auditBeforeText
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import javax.imageio.ImageIO

/**
 * Removing a photo (backlog A4, the owner's decision of 2026-11-04): from an entry that is not signed, by the manager of the project
 * (any photo) or by the worker who uploaded it (their own). Everybody else is refused, a signed entry never loses a photo, a photo
 * that the caller cannot see looks exactly like one that does not exist, and the removal is audited with what the photo was.
 */
class PhotoDeleteRoutesTest : BaseIntegrationTest() {

    private class Site(
        val boss: SessionUser,
        val worker: SessionUser,
        val otherWorker: SessionUser,
        val inspector: SessionUser,
        val investor: SessionUser,
        val projectId: UUID,
        val reportId: UUID,
        val date: String,
    )

    private fun jpeg(): ByteArray {
        val image = BufferedImage(200, 150, BufferedImage.TYPE_INT_RGB)
        val out = ByteArrayOutputStream()
        ImageIO.write(image, "jpeg", out)
        return out.toByteArray()
    }

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER)
        val otherWorker = createTestUser(role = Role.WORKER)
        val inspector = createTestUser(role = Role.INSPECTOR)
        val investor = createTestUser(role = Role.INVESTOR)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Removal Project", address = "Adresa", cadastralArea = "Area", parcelNumbers = "1",
                builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        listOf(worker, otherWorker, inspector, investor).forEach { addMember(projectId, it) }
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29", workDescription = "Betonáž")
        return Site(boss, worker, otherWorker, inspector, investor, projectId, UUID.fromString(report.id), "2026-09-29")
    }

    private suspend fun upload(by: SessionUser, s: Site): UUID = PhotoService.uploadPhoto(by, s.reportId, jpeg(), "image/jpeg", "a.jpg").id

    private fun auditRows(action: String) = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.asc()).fetch()

    /** The two files of a stored photo: the original, then the thumbnail (null when a file is not there any more). */
    private fun filesOf(photoId: UUID): List<Path?> {
        val row = dsl.select(PHOTOS.PATHORIGINAL, PHOTOS.PATHTHUMB).from(PHOTOS).where(PHOTOS.ID.eq(photoId)).fetchOne()!!
        return listOf(PhotoStorage.resolve(row.get(PHOTOS.PATHORIGINAL)!!), PhotoStorage.resolve(row.get(PHOTOS.PATHTHUMB)!!))
    }

    private fun photoCount(): Int = dsl.fetchCount(PHOTOS)

    private suspend fun ApplicationTestBuilder.remove(photoId: Any, who: SessionUser?): HttpResponse =
        client.delete("/api/photos/$photoId") { if (who != null) header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(who)}") }

    private fun errorOf(response: String): String = Json.parseToJsonElement(response).jsonObject["error"]!!.jsonPrimitive.content

    // --- who may ---------------------------------------------------------------------------------

    @Test
    fun `removing a photo needs a session`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.boss, s)

        val response = remove(photo, null)

        assertEquals(HttpStatusCode.Unauthorized, response.status)
        assertEquals(1, photoCount())
        assertTrue(auditRows("photo.delete").isEmpty())
    }

    @Test
    fun `the manager removes any photo, a worker's too, and both files go`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.worker, s)
        val (original, thumbnail) = filesOf(photo)
        assertNotNull(original)
        assertNotNull(thumbnail)

        val response = remove(photo, s.boss)

        assertEquals(HttpStatusCode.NoContent, response.status, response.bodyAsText())
        assertEquals(0, photoCount())
        assertFalse(Files.exists(original!!), "the original is removed from the volume")
        assertFalse(Files.exists(thumbnail!!), "the thumbnail is removed from the volume")
    }

    @Test
    fun `a worker removes the photo they uploaded`() = testApplication {
        application { module() }
        val s = site()
        val own = upload(s.worker, s)
        val another = upload(s.otherWorker, s)

        val response = remove(own, s.worker)

        assertEquals(HttpStatusCode.NoContent, response.status, response.bodyAsText())
        assertEquals(setOf(another), dsl.select(PHOTOS.ID).from(PHOTOS).fetch(PHOTOS.ID).toSet(), "only their own photo is gone")
    }

    @Test
    fun `a worker cannot remove a photo another worker or the manager uploaded`() = testApplication {
        application { module() }
        val s = site()
        val workers = upload(s.otherWorker, s)
        val managers = upload(s.boss, s)
        val kept = listOf(workers, managers).flatMap { filesOf(it) }

        for (photo in listOf(workers, managers)) {
            val response = remove(photo, s.worker)
            assertEquals(HttpStatusCode.Forbidden, response.status, "removing $photo")
        }

        assertEquals(2, photoCount())
        assertTrue(kept.all { it != null && Files.exists(it) }, "no file was touched")
        assertTrue(auditRows("photo.delete").isEmpty(), "a refusal leaves no audit row")
    }

    @Test
    fun `the supervision and the client may not remove a photo, not even to see it again`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.worker, s)

        for (who in listOf(s.inspector, s.investor)) {
            assertEquals(HttpStatusCode.Forbidden, remove(photo, who).status, "role ${who.role}")
        }

        assertEquals(1, photoCount())
        assertTrue(filesOf(photo).all { it != null })
    }

    @Test
    fun `somebody who is not a member of the project gets 404, the same as for a photo that does not exist`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.boss, s)
        // A manager, but of a project of their own: the photo is none of their business.
        val outsider = createTestUser(role = Role.BOSS)
        ProjectService.createProject(
            outsider,
            ProjectDto(id = "", name = "Another", address = "A", cadastralArea = "A", parcelNumbers = "1", builder = "B", contractor = "C", siteManagerId = outsider.id.toString()),
        )

        val outsiders = remove(photo, outsider)
        val unknown = remove(UUID.randomUUID(), outsider)

        assertEquals(HttpStatusCode.NotFound, outsiders.status)
        assertEquals(HttpStatusCode.NotFound, unknown.status)
        assertEquals(errorOf(unknown.bodyAsText()), errorOf(outsiders.bodyAsText()), "the answer does not say which of the two it was")
        assertEquals(1, photoCount())
        assertTrue(auditRows("photo.delete").isEmpty())
    }

    @Test
    fun `the manager of another project gets 404 for the photo of this one, and an unknown or malformed id is not a 500`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.boss, s)
        val other = createTestUser(role = Role.BOSS)
        val otherProject = UUID.fromString(
            ProjectService.createProject(
                other,
                ProjectDto(id = "", name = "Second", address = "A", cadastralArea = "A", parcelNumbers = "1", builder = "B", contractor = "C", siteManagerId = other.id.toString()),
            ).id,
        )
        DailyReportService.createReport(other, otherProject, "2026-09-29")

        assertEquals(HttpStatusCode.NotFound, remove(photo, other).status)
        assertEquals(HttpStatusCode.NotFound, remove(UUID.randomUUID(), s.boss).status)
        assertEquals(HttpStatusCode.BadRequest, remove("not-an-id", s.boss).status)
        assertEquals(1, photoCount())
    }

    @Test
    fun `an administrator who is not a member has no right to remove a photo`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.boss, s)

        for (admin in listOf(createTestUser(role = Role.BOSS, isAdmin = true), createTestUser(role = Role.WORKER, isAdmin = true))) {
            // An administrator may open every project to read it, so there is nothing to hide: refused, not "not found".
            assertEquals(HttpStatusCode.Forbidden, remove(photo, admin).status)
        }

        assertEquals(1, photoCount())
        assertTrue(auditRows("photo.delete").isEmpty())
    }

    @Test
    fun `a manager's right is the right in THIS project, whatever their account says`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.otherWorker, s)
        // A global BOSS who is only a worker in this project.
        val demoted = createTestUser(role = Role.BOSS)
        addMember(s.projectId, demoted, Role.WORKER)

        assertEquals(HttpStatusCode.Forbidden, remove(photo, demoted).status)
        // And a global WORKER who manages it.
        val promoted = createTestUser(role = Role.WORKER)
        addMember(s.projectId, promoted, Role.BOSS)
        assertEquals(HttpStatusCode.NoContent, remove(photo, promoted).status)
    }

    // --- a signed entry --------------------------------------------------------------------------

    @Test
    fun `a signed entry never loses a photo, 409 with a message at the application and a refusal at the database`() = testApplication {
        application { module() }
        val s = site()
        val workersPhoto = upload(s.worker, s)
        val managersPhoto = upload(s.boss, s)
        signUnchecked(s.boss, s.reportId)
        val chainBefore = AuditService.verifyChain(dsl)

        // The manager, and the worker who uploaded it: the two who could remove it before the signature.
        for ((photo, who) in listOf(workersPhoto to s.boss, workersPhoto to s.worker, managersPhoto to s.boss)) {
            val response = remove(photo, who)
            assertEquals(HttpStatusCode.Conflict, response.status, "removing $photo as ${who.role}")
            val message = errorOf(response.bodyAsText())
            assertTrue(message.contains("podepsan"), "the message says why: $message")
            assertTrue(message.contains("dodat"), "and where a correction goes (an addendum): $message")
        }
        // Somebody who could never remove it is told that, not that the entry is signed.
        assertEquals(HttpStatusCode.Forbidden, remove(workersPhoto, s.inspector).status)
        assertEquals(HttpStatusCode.Forbidden, remove(workersPhoto, s.otherWorker).status)

        assertEquals(2, photoCount())
        assertTrue(listOf(workersPhoto, managersPhoto).flatMap { filesOf(it) }.all { it != null }, "no file was touched")
        assertTrue(auditRows("photo.delete").isEmpty())
        assertEquals(chainBefore.totalRows, AuditService.verifyChain(dsl).totalRows, "nothing was written")
        // The database says the same by itself, for a path that forgot to ask.
        assertThrows(org.jooq.exception.DataAccessException::class.java) { dsl.deleteFrom(PHOTOS).where(PHOTOS.ID.eq(workersPhoto)).execute() }
        assertEquals(2, photoCount())
    }

    // --- what is left behind ---------------------------------------------------------------------

    @Test
    fun `after the removal the photo is not served, not listed and not in the signature of a later signing`() = testApplication {
        application { module() }
        val s = site()
        val gone = upload(s.worker, s)
        val kept = upload(s.boss, s)
        val token = generateJwtToken(s.boss)

        assertEquals(HttpStatusCode.NoContent, remove(gone, s.boss).status)

        for (suffix in listOf("", "/thumb")) {
            assertEquals(HttpStatusCode.NotFound, client.get("/api/photos/$gone$suffix") { header(HttpHeaders.Authorization, "Bearer $token") }.status, "GET $suffix")
            assertEquals(HttpStatusCode.OK, client.get("/api/photos/$kept$suffix") { header(HttpHeaders.Authorization, "Bearer $token") }.status, "the other one is still served")
        }
        val entry = client.get("/api/projects/${s.projectId}/reports/${s.date}") { header(HttpHeaders.Authorization, "Bearer $token") }
        val listed = Json.parseToJsonElement(entry.bodyAsText()).jsonObject["photos"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertEquals(listOf(kept.toString()), listed)

        // A later signature covers what the entry has then.
        signUnchecked(s.boss, s.reportId)
        val check = client.get("/api/reports/${s.reportId}/signature") { header(HttpHeaders.Authorization, "Bearer $token") }
        val body = Json.parseToJsonElement(check.bodyAsText()).jsonObject
        assertTrue(body["contentMatches"]!!.jsonPrimitive.boolean, "the signature matches the one photo that is left")
        assertTrue(body["photoFilesMatch"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `the removal is audited with what the photo was, and no secret`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.worker, s)
        val stored = dsl.selectFrom(PHOTOS).where(PHOTOS.ID.eq(photo)).fetchOne()!!

        assertEquals(HttpStatusCode.NoContent, remove(photo, s.boss).status)

        val row = auditRows("photo.delete").single()
        assertEquals("photo", row.get(AUDIT_LOG.ENTITY_TYPE))
        assertEquals(photo.toString(), row.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(s.boss.id.toString(), row.get(AUDIT_LOG.ACTOR_ID), "the audit row names who removed it, not who uploaded it")
        assertEquals(s.projectId, row.get(AUDIT_LOG.PROJECT_ID), "the row belongs to the project")
        assertNull(row.auditAfterText(), "nothing is left")
        val before = Json.parseToJsonElement(row.auditBeforeText()!!).jsonObject
        assertEquals(photo.toString(), before["id"]!!.jsonPrimitive.content)
        assertEquals(s.reportId.toString(), before["reportId"]!!.jsonPrimitive.content)
        assertEquals(s.projectId.toString(), before["projectId"]!!.jsonPrimitive.content)
        assertEquals(stored.sha256, before["sha256Original"]!!.jsonPrimitive.content, "the hash of the original is kept, so the file can be recognised")
        assertEquals(stored.thumbsha256, before["sha256Thumbnail"]!!.jsonPrimitive.content)
        assertEquals(64, before["sha256Original"]!!.jsonPrimitive.content.length)
        assertEquals(s.worker.id.toString(), before["uploadedById"]!!.jsonPrimitive.content, "who uploaded it")
        assertEquals(s.worker.displayName, before["uploadedByName"]!!.jsonPrimitive.content)
        assertEquals(stored.width, before["width"]!!.jsonPrimitive.content.toInt())
        assertEquals(stored.height, before["height"]!!.jsonPrimitive.content.toInt())
        // What the audit log may not hold: where the files are, and the session or the password of anyone.
        val text = row.auditBeforeText()!!
        assertFalse(text.contains("photos/"), "no storage key in the audit row")
        assertFalse(text.contains(".jpg"), "no file name in the audit row")
        assertFalse(text.contains(stored.pathoriginal!!), "no storage key in the audit row")
        assertTrue(AuditService.verifyChain(dsl).ok, "the chain still verifies")
    }

    @Test
    fun `a file that is already gone does not stop the removal`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.boss, s)
        val (original, thumbnail) = filesOf(photo)
        Files.delete(original!!)

        val response = remove(photo, s.boss)

        assertEquals(HttpStatusCode.NoContent, response.status, response.bodyAsText())
        assertEquals(0, photoCount())
        assertFalse(Files.exists(thumbnail!!), "the file that was there is removed")
        assertEquals(1, auditRows("photo.delete").size)
    }

    @Test
    fun `a file that cannot be deleted does not undo the removal and is not told to the client`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.boss, s)
        val (original, thumbnail) = filesOf(photo)
        // The original is replaced by a directory that is not empty: the file system refuses to delete it.
        val bytes = Files.readAllBytes(original!!)
        Files.delete(original)
        Files.createDirectory(original)
        Files.write(original.resolve("inside.bin"), bytes)

        try {
            val response = remove(photo, s.boss)

            assertEquals(HttpStatusCode.NoContent, response.status, response.bodyAsText())
            assertEquals("", response.bodyAsText(), "no word of paths or files in the answer")
            assertEquals(0, photoCount(), "the photo is removed all the same")
            assertEquals(1, auditRows("photo.delete").size, "and the removal is on the record")
            assertFalse(Files.exists(thumbnail!!), "the other file is still removed")
            assertTrue(Files.exists(original), "what could not be deleted is left, an orphan that nothing refers to")
        } finally {
            Files.deleteIfExists(original.resolve("inside.bin"))
            Files.deleteIfExists(original)
        }
    }

    @Test
    fun `a tampered storage key is never followed, and the removal goes on`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.boss, s)
        // A file outside the uploads directory (next to it), and a row that points at it two ways.
        val uploads = AppConfig.uploadsDir.toAbsolutePath().normalize()
        val outside = uploads.parent.resolve("not-a-photo-${UUID.randomUUID()}.jpg")
        Files.write(outside, byteArrayOf(1, 2, 3))
        try {
            val (original, thumbnail) = filesOf(photo)
            dsl.update(PHOTOS)
                .set(PHOTOS.PATHORIGINAL, "../${outside.fileName}")
                .set(PHOTOS.PATHTHUMB, "photos/../../${outside.fileName}")
                .where(PHOTOS.ID.eq(photo)).execute()

            val response = remove(photo, s.boss)

            assertEquals(HttpStatusCode.NoContent, response.status, response.bodyAsText())
            assertEquals(0, photoCount())
            assertTrue(Files.exists(outside), "a key that is not of the exact shape is not followed: the file outside is untouched")
            assertTrue(Files.exists(original!!) && Files.exists(thumbnail!!), "and the files the row no longer names stay where they were (orphans)")
        } finally {
            Files.deleteIfExists(outside)
        }
    }

    @Test
    fun `two requests for the same photo give one removal and one 404`() = testApplication {
        application { module() }
        val s = site()
        val photo = upload(s.boss, s)

        val statuses = coroutineScope {
            listOf(s.boss, s.boss).map { who -> async(Dispatchers.IO) { remove(photo, who).status } }.awaitAll()
        }

        assertEquals(listOf(HttpStatusCode.NoContent, HttpStatusCode.NotFound), statuses.sortedBy { it.value })
        assertEquals(1, auditRows("photo.delete").size, "one removal, one row")
    }

    // --- what the page is told -------------------------------------------------------------------

    @Test
    fun `every photo of the entry says whether the person who asks may remove it`() = testApplication {
        application { module() }
        val s = site()
        val workersPhoto = upload(s.worker, s)
        val managersPhoto = upload(s.boss, s)
        val outsider = createTestUser(role = Role.BOSS, isAdmin = true)

        suspend fun canDelete(who: SessionUser, path: String): Map<String, Boolean> {
            val response = client.get(path) { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(who)}") }.bodyAsText()
            val photos = Json.parseToJsonElement(response).let { json ->
                if (json is JsonArray) json.first().jsonObject["photos"]!!.jsonArray else json.jsonObject["photos"]!!.jsonArray
            }
            return photos.associate { it.jsonObject["id"]!!.jsonPrimitive.content to it.jsonObject["canDelete"]!!.jsonPrimitive.boolean }
        }
        val day = "/api/projects/${s.projectId}/reports/${s.date}"
        val list = "/api/projects/${s.projectId}/reports"

        for (path in listOf(day, list)) {
            assertEquals(mapOf(workersPhoto.toString() to true, managersPhoto.toString() to true), canDelete(s.boss, path), "the manager, $path")
            assertEquals(mapOf(workersPhoto.toString() to true, managersPhoto.toString() to false), canDelete(s.worker, path), "the worker who uploaded the first, $path")
            assertEquals(mapOf(workersPhoto.toString() to false, managersPhoto.toString() to false), canDelete(s.otherWorker, path), "another worker, $path")
            assertEquals(mapOf(workersPhoto.toString() to false, managersPhoto.toString() to false), canDelete(s.inspector, path), "the supervision, $path")
            assertEquals(mapOf(workersPhoto.toString() to false, managersPhoto.toString() to false), canDelete(s.investor, path), "the client, $path")
            assertEquals(mapOf(workersPhoto.toString() to false, managersPhoto.toString() to false), canDelete(outsider, path), "an administrator who is no member, $path")
        }

        signUnchecked(s.boss, s.reportId)
        for (path in listOf(day, list)) {
            for (who in listOf(s.boss, s.worker)) {
                assertTrue(canDelete(who, path).values.none { it }, "a signed entry offers no removal to ${who.role}, $path")
            }
        }
    }

    @Test
    fun `a photo that was just uploaded says that its uploader may remove it`() = testApplication {
        application { module() }
        val s = site()
        val token = generateJwtToken(s.worker)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", s.reportId.toString())
                append("photo", jpeg(), Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"a.jpg\"")
                })
            },
        ) { header(HttpHeaders.Authorization, "Bearer $token") }

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val photo = Json.parseToJsonElement(response.bodyAsText()).jsonObject["photo"]!!.jsonObject
        assertTrue(photo["canDelete"]!!.jsonPrimitive.boolean)
        assertEquals(HttpStatusCode.NoContent, remove(photo["id"]!!.jsonPrimitive.content, s.worker).status)
    }

}
