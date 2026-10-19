package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.FakeTypst
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.JpegSamples
import cz.stavebni.denik.services.PdfExportException
import cz.stavebni.denik.services.PdfExportService
import cz.stavebni.denik.services.PdfUnavailableException
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.RateLimiter
import cz.stavebni.denik.services.TypstCompiler
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Limits on volume per user (backlog A5): photo uploads 60 per 5 minutes, PDF exports 20 per 5 minutes, administrator
 * password resets 10 per 15 minutes. Every attempt counts (`reserve` without `release`); the one exception is an export that
 * the server could not do (busy, no typst), which is given back. An answer at the limit is `429` with `Retry-After` and a
 * Czech message, as for the login limiter.
 */
class VolumeLimitsRoutesTest : BaseIntegrationTest() {

    private val originalQueueWait: Duration = PdfExportService.queueWait

    @AfterEach
    fun restorePdf() {
        PdfExportService.queueWait = originalQueueWait
    }

    private class Site(val boss: SessionUser, val projectId: UUID, val reportIds: List<String>)

    private suspend fun site(days: List<String> = listOf("2026-09-28")): Site {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Volume Limits Project", address = "Stavebni 10", cadastralArea = "Praha",
                parcelNumbers = "100/1", builder = "Investor a.s.", contractor = "Stavitel s.r.o.", siteManagerId = boss.id.toString()
            )
        )
        val projectId = UUID.fromString(project.id)
        return Site(boss, projectId, days.map { DailyReportService.createReport(boss, projectId, it).id })
    }

    private fun bearer(user: SessionUser) = "Bearer ${generateJwtToken(user)}"

    /** [n] attempts already on record for [key] in [rule], as if the person had made them a moment ago. */
    private fun record(rule: RateLimiter.Rule, user: SessionUser, n: Int) =
        repeat(n) { assertNull(RateLimiter.reserve(dsl, listOf(rule to user.id.toString())).refusedFor) }

    private fun attempts(rule: RateLimiter.Rule, user: SessionUser): Int =
        dsl.fetchCount(RATE_LIMIT_ATTEMPTS, RATE_LIMIT_ATTEMPTS.BUCKET.eq(rule.bucket).and(RATE_LIMIT_ATTEMPTS.KEY.eq(user.id.toString())))

    private val jpeg = JpegSamples.smooth(120, 90)

    private suspend fun ApplicationTestBuilder.upload(user: SessionUser, reportId: String, file: ByteArray = jpeg): HttpResponse =
        client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                append("photo", file, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"p.jpg\"")
                })
            }
        ) { header(HttpHeaders.Authorization, bearer(user)) }

    private suspend fun ApplicationTestBuilder.pdf(user: SessionUser, reportId: String): HttpResponse =
        client.get("/api/reports/$reportId/pdf") { header(HttpHeaders.Authorization, bearer(user)) }

    private fun assertRefused(response: HttpResponse, body: String, mentions: String) {
        assertEquals(HttpStatusCode.TooManyRequests, response.status, body)
        val wait = response.headers[HttpHeaders.RetryAfter]?.toLongOrNull()
        assertNotNull(wait, "Retry-After says when to come back")
        assertTrue(wait!! in 1..900, "a wait inside the window, was $wait")
        assertTrue(body.contains(mentions) && body.contains("Zkuste to znovu za"), body)
    }

    // --- photos: 60 per 5 minutes ---------------------------------------------------------------

    @Test
    fun `the 61st photo upload within five minutes is refused with 429, a wait and a Czech message`() = testApplication {
        application { module() }
        val s = site()
        record(RateLimiter.Rules.PHOTO_UPLOAD, s.boss, 60)

        val response = upload(s.boss, s.reportIds[0])

        assertRefused(response, response.bodyAsText(), "nahrávání fotografií")
        assertEquals(0, dsl.fetchCount(PHOTOS))
        assertEquals(60, attempts(RateLimiter.Rules.PHOTO_UPLOAD, s.boss), "a refused request is not recorded: asking again does not extend the wait")
    }

    @Test
    fun `every upload attempt counts, a failed one and a successful one alike`() = testApplication {
        application { module() }
        val s = site()
        record(RateLimiter.Rules.PHOTO_UPLOAD, s.boss, 58)

        assertEquals(HttpStatusCode.OK, upload(s.boss, s.reportIds[0]).status)
        assertEquals(59, attempts(RateLimiter.Rules.PHOTO_UPLOAD, s.boss), "a success is not given back")
        assertEquals(HttpStatusCode.BadRequest, upload(s.boss, s.reportIds[0], "text".toByteArray()).status)
        assertEquals(60, attempts(RateLimiter.Rules.PHOTO_UPLOAD, s.boss), "a failure counts too")

        assertEquals(HttpStatusCode.TooManyRequests, upload(s.boss, s.reportIds[0]).status)
    }

    @Test
    fun `the upload limit is the person's own, not shared`() = testApplication {
        application { module() }
        val s = site()
        val colleague = createTestUser(role = Role.WORKER).also { addMember(s.projectId, it) }
        record(RateLimiter.Rules.PHOTO_UPLOAD, s.boss, 60)

        assertEquals(HttpStatusCode.TooManyRequests, upload(s.boss, s.reportIds[0]).status)
        assertEquals(HttpStatusCode.OK, upload(colleague, s.reportIds[0]).status)
    }

    // --- PDF: 20 per 5 minutes, given back when busy or unavailable -----------------------------

    @Test
    fun `the 21st PDF export within five minutes is refused with 429, a wait and a Czech message`() = testApplication {
        application { module() }
        val s = site()
        record(RateLimiter.Rules.PDF_EXPORT, s.boss, 20)

        val response = pdf(s.boss, s.reportIds[0])

        assertRefused(response, response.bodyAsText(), "exportů")
        assertNotEquals(ContentType.Application.Pdf, response.contentType()?.withoutParameters())
        assertEquals(20, attempts(RateLimiter.Rules.PDF_EXPORT, s.boss))
    }

    @Test
    fun `an export that is refused as busy is given back, so it does not use up the person's twenty`() = testApplication {
        application { module() }
        val s = site(listOf("2026-09-26", "2026-09-27", "2026-09-28"))
        val release = CountDownLatch(1)
        val started = CountDownLatch(2)
        PdfExportService.compiler = TypstCompiler { workDir, typst, pdf ->
            started.countDown()
            release.await(30, TimeUnit.SECONDS)
            FakeTypst.compile(workDir, typst, pdf)
        }
        PdfExportService.queueWait = Duration.ofMillis(300)
        record(RateLimiter.Rules.PDF_EXPORT, s.boss, 17) // with the two exports below this is 19: one more is allowed

        coroutineScope {
            val holders = s.reportIds.take(2).map { id -> async(Dispatchers.IO) { pdf(s.boss, id) } }
            assertTrue(started.await(20, TimeUnit.SECONDS), "both renders started")
            assertEquals(19, attempts(RateLimiter.Rules.PDF_EXPORT, s.boss))

            val busy = pdf(s.boss, s.reportIds[2])

            assertEquals(HttpStatusCode.ServiceUnavailable, busy.status, busy.bodyAsText())
            assertTrue(busy.bodyAsText().contains("PDF_BUSY"))
            assertEquals(19, attempts(RateLimiter.Rules.PDF_EXPORT, s.boss), "the refused attempt was given back")
            release.countDown()
            assertEquals(listOf(HttpStatusCode.OK, HttpStatusCode.OK), holders.awaitAll().map { it.status })
        }

        PdfExportService.compiler = FakeTypst
        assertEquals(HttpStatusCode.OK, pdf(s.boss, s.reportIds[2]).status, "the 20th is allowed")
        assertEquals(HttpStatusCode.TooManyRequests, pdf(s.boss, s.reportIds[2]).status, "the 21st is not")
    }

    @Test
    fun `an export that cannot be done because typst is missing is given back too, one that fails otherwise is not`() = testApplication {
        application { module() }
        val s = site()

        PdfExportService.compiler = TypstCompiler { _, _, _ -> throw PdfUnavailableException("typst could not be started") }
        assertEquals(HttpStatusCode.ServiceUnavailable, pdf(s.boss, s.reportIds[0]).status)
        assertEquals(0, attempts(RateLimiter.Rules.PDF_EXPORT, s.boss), "not the person's doing")

        PdfExportService.compiler = TypstCompiler { _, _, _ -> throw PdfExportException("typst failed") }
        assertEquals(HttpStatusCode.InternalServerError, pdf(s.boss, s.reportIds[0]).status)
        assertEquals(1, attempts(RateLimiter.Rules.PDF_EXPORT, s.boss), "an export that failed was still an attempt")
    }

    @Test
    fun `a request for an export that is refused for who is asking is not charged`() = testApplication {
        application { module() }
        val s = site()
        val stranger = createTestUser(role = Role.WORKER)

        assertEquals(HttpStatusCode.Forbidden, pdf(stranger, s.reportIds[0]).status)
        assertEquals(HttpStatusCode.NotFound, pdf(s.boss, UUID.randomUUID().toString()).status)

        assertEquals(0, attempts(RateLimiter.Rules.PDF_EXPORT, stranger))
        assertEquals(0, attempts(RateLimiter.Rules.PDF_EXPORT, s.boss))
    }

    @Test
    fun `both PDF routes share the person's limit`() = testApplication {
        application { module() }
        val s = site()
        record(RateLimiter.Rules.PDF_EXPORT, s.boss, 19)

        assertEquals(HttpStatusCode.OK, pdf(s.boss, s.reportIds[0]).status)
        val byDay = client.get("/api/projects/${s.projectId}/reports/2026-09-28/pdf") { header(HttpHeaders.Authorization, bearer(s.boss)) }

        assertEquals(HttpStatusCode.TooManyRequests, byDay.status, byDay.bodyAsText())
    }

    // --- administrator password resets: 10 per 15 minutes ---------------------------------------

    private suspend fun ApplicationTestBuilder.reset(actor: SessionUser, target: SessionUser): HttpResponse =
        client.post("/api/users/${target.id}/reset-password") { header(HttpHeaders.Authorization, bearer(actor)) }

    private fun passwordHashOf(user: SessionUser): String =
        dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(user.id)).fetchSingle(USERS.PASSWORDHASH)!!

    @Test
    fun `the 11th password reset by one administrator within 15 minutes is refused with 429 and changes nothing`() = testApplication {
        application { module() }
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val otherAdmin = createTestUser(role = Role.BOSS, isAdmin = true)
        val target = createTestUser(role = Role.WORKER)
        val hashBefore = passwordHashOf(target)
        record(RateLimiter.Rules.ADMIN_PASSWORD_RESET, admin, 10)

        val response = reset(admin, target)

        assertRefused(response, response.bodyAsText(), "obnovení hesel")
        assertEquals(hashBefore, passwordHashOf(target), "the password was not reset")
        assertEquals(HttpStatusCode.OK, reset(otherAdmin, target).status, "the limit is per acting administrator")
        assertNotEquals(hashBefore, passwordHashOf(target))
    }

    @Test
    fun `a reset counts as an attempt, and a request from someone who may not reset is not charged`() = testApplication {
        application { module() }
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val boss = createTestUser(role = Role.BOSS)
        val target = createTestUser(role = Role.WORKER)

        assertEquals(HttpStatusCode.Forbidden, reset(boss, target).status)
        assertEquals(0, attempts(RateLimiter.Rules.ADMIN_PASSWORD_RESET, boss), "refused for who is asking, so not counted")

        assertEquals(HttpStatusCode.OK, reset(admin, target).status)
        assertEquals(1, attempts(RateLimiter.Rules.ADMIN_PASSWORD_RESET, admin))
    }

    @Test
    fun `the limits are the numbers of the backlog`() {
        assertEquals(60 to Duration.ofMinutes(5), RateLimiter.Rules.PHOTO_UPLOAD.maxFailures to RateLimiter.Rules.PHOTO_UPLOAD.window)
        assertEquals(20 to Duration.ofMinutes(5), RateLimiter.Rules.PDF_EXPORT.maxFailures to RateLimiter.Rules.PDF_EXPORT.window)
        assertEquals(10 to Duration.ofMinutes(15), RateLimiter.Rules.ADMIN_PASSWORD_RESET.maxFailures to RateLimiter.Rules.ADMIN_PASSWORD_RESET.window)
    }
}
