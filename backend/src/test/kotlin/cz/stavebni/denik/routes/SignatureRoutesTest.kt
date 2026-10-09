package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.PhotoService
import cz.stavebni.denik.services.PhotoStorage
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.UUID
import javax.imageio.ImageIO

/**
 * Signing is an act (decision D8 and D2): it asks for the password again, needs a ČKAIT number, and records a SHA-256 of
 * the content that was signed, which can be checked later against the entry as it is then.
 */
class SignatureRoutesTest : BaseIntegrationTest() {

    private suspend fun project(owner: SessionUser): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = "Signed site", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private suspend fun ApplicationTestBuilder.sign(user: SessionUser, reportId: String, body: String?): HttpResponse =
        client.post("/api/reports/$reportId/sign") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }

    private suspend fun ApplicationTestBuilder.check(user: SessionUser, reportId: String): JsonObject =
        Json.parseToJsonElement(
            client.get("/api/reports/$reportId/signature") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }.bodyAsText()
        ).jsonObject

    private fun password(p: String = "Password123!") = """{"password":"$p"}"""

    private fun jpeg(): ByteArray {
        val out = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(160, 120, BufferedImage.TYPE_INT_RGB), "jpeg", out)
        return out.toByteArray()
    }

    private fun row(reportId: String) = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(reportId))).fetchOne()!!

    // ------------------------------------------------------------------ the password

    @Test
    fun `signing needs the password again, and a wrong or missing one signs nothing`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val report = DailyReportService.createReport(boss, project(boss), "2026-09-28")

        for (body in listOf(null, "{}", """{"password":""}""", password("Wrong-Password-1!"))) {
            val response = sign(boss, report.id, body)
            assertEquals(HttpStatusCode.BadRequest, response.status, "body: $body -> ${response.bodyAsText()}")
        }
        assertNull(row(report.id).lockedat, "nothing was signed")
        assertNull(row(report.id).get(DAILY_REPORTS.SIGNATUREHASH))

        assertEquals(HttpStatusCode.OK, sign(boss, report.id, password()).status)
        assertNotNull(row(report.id).lockedat)
    }

    @Test
    fun `a wrong password is not a lapsed session, and five of them lock the signing for a while`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val report = DailyReportService.createReport(boss, project(boss), "2026-09-28")

        repeat(5) {
            val response = sign(boss, report.id, password("Wrong-Password-$it!"))
            assertEquals(HttpStatusCode.BadRequest, response.status, "a client error, never 401: that would open the sign-in dialog")
        }
        val locked = sign(boss, report.id, password())
        assertEquals(HttpStatusCode.TooManyRequests, locked.status, "even the right password is refused for now")
        assertNotNull(locked.headers[HttpHeaders.RetryAfter])
        assertNull(row(report.id).lockedat)

        dsl.deleteFrom(RATE_LIMIT_ATTEMPTS).execute()
        assertEquals(HttpStatusCode.OK, sign(boss, report.id, password()).status)
    }

    @Test
    fun `a right password gives its attempt back, so signing many entries does not lock the signer`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)
        val reports = (20..28).map { DailyReportService.createReport(boss, p, "2026-09-$it") }

        for (r in reports) assertEquals(HttpStatusCode.OK, sign(boss, r.id, password()).status)

        assertEquals(0, dsl.fetchCount(RATE_LIMIT_ATTEMPTS, RATE_LIMIT_ATTEMPTS.BUCKET.eq("signpw:user")))
    }

    @Test
    fun `someone who may not sign is told so before any password is asked for`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER)
        val p = project(boss)
        addMember(p, worker)
        val report = DailyReportService.createReport(boss, p, "2026-09-28")

        // A worker, with no password and with a wrong one: both are 403, neither tells anything about passwords.
        assertEquals(HttpStatusCode.Forbidden, sign(worker, report.id, null).status)
        assertEquals(HttpStatusCode.Forbidden, sign(worker, report.id, password("Wrong-Password-1!")).status)
        assertEquals(0, dsl.fetchCount(RATE_LIMIT_ATTEMPTS), "no guess was counted")
    }

    // ------------------------------------------------------------------ the ČKAIT number

    @Test
    fun `a manager without a CKAIT number cannot sign, and is told why`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val report = DailyReportService.createReport(boss, project(boss), "2026-09-28")
        dsl.update(USERS).set(USERS.CKAITNUMBER, null as String?).where(USERS.ID.eq(boss.id)).execute()

        val response = sign(boss, report.id, password())

        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertTrue(response.bodyAsText().contains("SIGNER_NOT_QUALIFIED"), response.bodyAsText())
        assertTrue(response.bodyAsText().contains("ČKAIT"), response.bodyAsText())
        assertNull(row(report.id).lockedat)

        dsl.update(USERS).set(USERS.CKAITNUMBER, "0099999").where(USERS.ID.eq(boss.id)).execute()
        assertEquals(HttpStatusCode.OK, sign(boss, report.id, password()).status)
    }

    @Test
    fun `a project cannot be created for a site manager without a CKAIT number, nor can one be made a manager`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val noNumber = createTestUser(nickname = "no_number", role = Role.BOSS, ckaitNumber = null)
        val p = project(boss)

        // As a site manager of a new project.
        val failure = runCatching {
            ProjectService.createProject(
                boss,
                ProjectDto(
                    id = "", name = "Another", address = "A", cadastralArea = "C", parcelNumbers = "1", builder = "B", contractor = "C",
                    siteManagerId = noNumber.id.toString()
                )
            )
        }
        assertTrue(failure.exceptionOrNull() is IllegalArgumentException, failure.toString())

        // As a creator of a project (who becomes its manager).
        assertTrue(runCatching { project(noNumber) }.exceptionOrNull() is IllegalArgumentException)

        // As a member with the manager role.
        val response = client.post("/api/projects/$p/members") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}")
            contentType(ContentType.Application.Json)
            setBody("""{"userId":"${noNumber.id}","role":"BOSS"}""")
        }
        assertEquals(HttpStatusCode.Conflict, response.status, response.bodyAsText())
        assertTrue(response.bodyAsText().contains("ČKAIT"))
        // A worker needs no number.
        val asWorker = client.post("/api/projects/$p/members") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}")
            contentType(ContentType.Application.Json)
            setBody("""{"userId":"${noNumber.id}","role":"WORKER"}""")
        }
        assertEquals(HttpStatusCode.OK, asWorker.status, asWorker.bodyAsText())
    }

    // ------------------------------------------------------------------ the recorded hash

    @Test
    fun `signing records a SHA-256 of the content, and checking it again matches`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS, nickname = "signer", displayName = "Jan Stavbyvedoucí")
        val report = DailyReportService.createReport(boss, project(boss), "2026-09-28", workDescription = "Betonáž stropu")

        val before = check(boss, report.id)
        assertEquals(false, before["signed"]!!.jsonPrimitive.boolean)
        assertNull(before["signatureHash"]?.jsonPrimitive?.contentOrNullSafe())

        assertEquals(HttpStatusCode.OK, sign(boss, report.id, password()).status)

        val stored = row(report.id)
        val hash = stored.get(DAILY_REPORTS.SIGNATUREHASH)
        assertNotNull(hash)
        assertTrue(Regex("[0-9a-f]{64}").matches(hash!!), hash)
        val after = check(boss, report.id)
        assertTrue(after["signed"]!!.jsonPrimitive.boolean)
        assertEquals(hash, after["signatureHash"]!!.jsonPrimitive.content)
        assertEquals("Jan Stavbyvedoucí", after["signedByName"]!!.jsonPrimitive.content)
        assertEquals("0012345", after["signerCkaitNumber"]!!.jsonPrimitive.content)
        assertTrue(after["contentMatches"]!!.jsonPrimitive.boolean, "the content hashed again is what was signed")
    }

    @Test
    fun `a change made to a signed entry behind the application's back is found`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val report = DailyReportService.createReport(boss, project(boss), "2026-09-28", workDescription = "Původní text")
        assertEquals(HttpStatusCode.OK, sign(boss, report.id, password()).status)
        assertTrue(check(boss, report.id)["contentMatches"]!!.jsonPrimitive.boolean)

        // Somebody with the table owner's rights switches the guard off and edits the text.
        dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
        try {
            dsl.execute("""update daily_reports set "workDescription" = 'Zfalšovaný text' where id = ?""", UUID.fromString(report.id))
        } finally {
            dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
        }

        val result = check(boss, report.id)
        assertFalse(result["contentMatches"]!!.jsonPrimitive.boolean, "the edit shows: the hash no longer matches")
    }

    @Test
    fun `the hash covers the photos, and a photo file swapped on the volume is found`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val reportId = DailyReportService.createReport(boss, project(boss), "2026-09-28").id
        val photo = PhotoService.uploadPhoto(boss, UUID.fromString(reportId), jpeg(), "image/jpeg", "site.jpg")
        assertEquals(HttpStatusCode.OK, sign(boss, reportId, password()).status)

        val matching = check(boss, reportId)
        assertTrue(matching["contentMatches"]!!.jsonPrimitive.boolean)
        assertTrue(matching["photoFilesMatch"]!!.jsonPrimitive.boolean)

        // The stored file is replaced by another picture.
        val key = dsl.select(PHOTOS.PATHORIGINAL).from(PHOTOS).where(PHOTOS.ID.eq(photo.id)).fetchOne(PHOTOS.PATHORIGINAL)!!
        val swapped = ByteArrayOutputStream().also { ImageIO.write(BufferedImage(160, 120, BufferedImage.TYPE_INT_ARGB).also { img -> img.setRGB(5, 5, 0xFFFF0000.toInt()) }, "png", it) }.toByteArray()
        java.nio.file.Files.write(PhotoStorage.resolve(key)!!, swapped)

        val tampered = check(boss, reportId)
        assertFalse(tampered["photoFilesMatch"]!!.jsonPrimitive.boolean, "the evidence photo is no longer the one that was signed")
        assertTrue(tampered["contentMatches"]!!.jsonPrimitive.boolean, "the rows are untouched: only the file changed")
    }

    @Test
    fun `an entry signed with different content has a different hash`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)
        val a = DailyReportService.createReport(boss, p, "2026-09-28", workDescription = "Text A")
        val b = DailyReportService.createReport(boss, p, "2026-09-29", workDescription = "Text A")
        assertEquals(HttpStatusCode.OK, sign(boss, a.id, password()).status)
        assertEquals(HttpStatusCode.OK, sign(boss, b.id, password()).status)

        assertNotEquals(row(a.id).get(DAILY_REPORTS.SIGNATUREHASH), row(b.id).get(DAILY_REPORTS.SIGNATUREHASH), "the date, the id and the time are covered")
    }

    @Test
    fun `the signature of a project can only be read by its members and administrators`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val stranger = createTestUser(role = Role.BOSS)
        val admin = createTestUser(role = Role.WORKER, isAdmin = true)
        project(stranger)
        val report = DailyReportService.createReport(boss, project(boss), "2026-09-28")

        val forStranger = client.get("/api/reports/${report.id}/signature") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(stranger)}") }
        assertEquals(HttpStatusCode.Forbidden, forStranger.status)
        val forAdmin = client.get("/api/reports/${report.id}/signature") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(admin)}") }
        assertEquals(HttpStatusCode.OK, forAdmin.status)
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? = if (isString || content != "null") content else null
