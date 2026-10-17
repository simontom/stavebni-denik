package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.JpegSamples
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.UploadGate
import cz.stavebni.denik.services.UploadLimits
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.http.content.*
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.testing.*
import io.ktor.utils.io.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.Socket
import java.time.Duration
import java.util.UUID

/**
 * The limit on upload bodies in flight (backlog A5, N4): taken before a byte of the body is read, refused with `429` (the
 * user's own limit) or `503` (the server's), and given back on every way an upload can end. A permit that leaks is a
 * self-inflicted denial of service, so every exit has a test: success, a refusal, an error, a body that breaks halfway, a
 * body that never arrives, a request that is cancelled.
 */
class PhotoUploadGateRoutesTest : BaseIntegrationTest() {

    private val boundary = "gate-test-boundary"
    private lateinit var originalGate: UploadGate
    private lateinit var originalTimeout: Duration

    @BeforeEach
    fun rememberLimits() {
        originalGate = UploadLimits.gate
        originalTimeout = UploadLimits.bodyTimeout
    }

    @AfterEach
    fun restoreLimits() {
        UploadLimits.gate = originalGate
        UploadLimits.bodyTimeout = originalTimeout
    }

    private class Site(val boss: SessionUser, val projectId: UUID, val reportId: String)

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Upload Gate Project", address = "Stavebni 10", cadastralArea = "Praha",
                parcelNumbers = "100/1", builder = "Investor a.s.", contractor = "Stavitel s.r.o.", siteManagerId = boss.id.toString()
            )
        )
        val projectId = UUID.fromString(project.id)
        return Site(boss, projectId, DailyReportService.createReport(boss, projectId, "2026-09-29").id)
    }

    private fun bearer(user: SessionUser) = "Bearer ${generateJwtToken(user)}"

    private suspend fun ApplicationTestBuilder.upload(user: SessionUser, reportId: String, file: ByteArray, extraFields: Map<String, String> = emptyMap()): HttpResponse =
        client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", reportId)
                extraFields.forEach { (k, v) -> append(k, v) }
                append("photo", file, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"p.jpg\"")
                })
            }
        ) { header(HttpHeaders.Authorization, bearer(user)) }

    /** A multipart body that is not multipart: had the server tried to read it, the answer would be a 400. */
    private suspend fun ApplicationTestBuilder.garbageUpload(user: SessionUser): HttpResponse =
        client.post("/api/photos/upload") {
            header(HttpHeaders.Authorization, bearer(user))
            contentType(ContentType.MultiPart.FormData.withParameter("boundary", boundary))
            setBody("this is not a multipart body at all")
        }

    /**
     * An upload that starts properly (the fields, then the first bytes of the photo) and then waits for [release]: the
     * server is in the middle of reading the body. After that the body just ends, without its closing boundary.
     */
    private fun halfUpload(reportId: String, release: CompletableDeferred<Unit>) =
        object : OutgoingContent.WriteChannelContent() {
            override val contentType: ContentType = ContentType.MultiPart.FormData.withParameter("boundary", boundary)
            override suspend fun writeTo(channel: ByteWriteChannel) {
                channel.writeStringUtf8(multipartStart(reportId))
                channel.writeFully(jpeg.copyOf(200))
                channel.flush()
                release.await()
                channel.flushAndClose()
            }
        }

    /** The fields, then the headers of the photo part: what a client sends before the first byte of the file. */
    private fun multipartStart(reportId: String) =
        "--$boundary\r\nContent-Disposition: form-data; name=\"reportId\"\r\n\r\n$reportId\r\n" +
            "--$boundary\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"p.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"

    private suspend fun awaitInFlight(gate: UploadGate, expected: Int) {
        withTimeout(20_000) { gate.inFlight.first { it == expected } }
    }

    private val jpeg = JpegSamples.smooth(120, 90)

    // --- refusals, before a byte is read -------------------------------------------------------------

    @Test
    fun `a user who has the permitted number of uploads in flight is refused with 429 and a wait, before the body is read`() = testApplication {
        application { module() }
        val s = site()
        val gate = UploadGate(maxTotal = 10, maxPerUser = 2).also { UploadLimits.gate = it }
        val held = listOf(gate.tryAcquire(s.boss.id), gate.tryAcquire(s.boss.id)).map { it as UploadGate.Permit }

        val response = garbageUpload(s.boss)

        assertEquals(HttpStatusCode.TooManyRequests, response.status, "429, not the 400 that reading the garbage would give: ${response.bodyAsText()}")
        assertNotNull(response.headers[HttpHeaders.RetryAfter], "it says when to come back")
        assertTrue(response.bodyAsText().contains("Právě se nahrává"), response.bodyAsText())
        assertEquals(0, dsl.fetchCount(PHOTOS))
        assertEquals(0, dsl.fetchCount(RATE_LIMIT_ATTEMPTS), "a request that was not even looked at is not charged to the user's volume limit")
        held.forEach { it.close() }
    }

    @Test
    fun `when the server has all its uploads in flight another user is refused with 503, UPLOAD_BUSY and a wait`() = testApplication {
        application { module() }
        val s = site()
        val other = createTestUser(role = Role.WORKER)
        val gate = UploadGate(maxTotal = 2, maxPerUser = 2).also { UploadLimits.gate = it }
        val held = List(2) { gate.tryAcquire(other.id) as UploadGate.Permit }

        val response = garbageUpload(s.boss)

        assertEquals(HttpStatusCode.ServiceUnavailable, response.status, response.bodyAsText())
        assertEquals(UploadLimits.RETRY_AFTER_SECONDS.toString(), response.headers[HttpHeaders.RetryAfter])
        assertTrue(response.bodyAsText().contains("UPLOAD_BUSY"), response.bodyAsText())
        held.forEach { it.close() }
        assertEquals(HttpStatusCode.BadRequest, garbageUpload(s.boss).status, "with room again the body is read (and is garbage)")
    }

    // --- every way out gives the permit back ---------------------------------------------------------

    @Test
    fun `the permit is given back after a success, a refusal and every kind of error`() = testApplication {
        application { module() }
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR).also { addMember(s.projectId, it) }
        val gate = UploadGate(maxTotal = 1, maxPerUser = 1).also { UploadLimits.gate = it }

        // Each of these would leave the one permit taken if some path forgot to close it, and the next one would be a 429.
        val outcomes = listOf(
            "ok" to upload(s.boss, s.reportId, jpeg).status,
            "garbage body" to garbageUpload(s.boss).status,
            "not an image" to upload(s.boss, s.reportId, "text".toByteArray()).status,
            "no such entry" to upload(s.boss, UUID.randomUUID().toString(), jpeg).status,
            "a role that may not upload" to upload(investor, s.reportId, jpeg).status,
            "file over 5 MiB" to upload(s.boss, s.reportId, ByteArray(5_500 * 1024) { 0xFF.toByte() }).status,
            "body over the request limit" to upload(s.boss, s.reportId, ByteArray(7 * 1024 * 1024) { 0x41 }).status,
            "ok again" to upload(s.boss, s.reportId, jpeg).status,
        )

        assertEquals(
            listOf(
                "ok" to HttpStatusCode.OK,
                "garbage body" to HttpStatusCode.BadRequest,
                "not an image" to HttpStatusCode.BadRequest,
                "no such entry" to HttpStatusCode.NotFound,
                "a role that may not upload" to HttpStatusCode.Forbidden,
                "file over 5 MiB" to HttpStatusCode.BadRequest,
                "body over the request limit" to HttpStatusCode.PayloadTooLarge,
                "ok again" to HttpStatusCode.OK,
            ),
            outcomes
        )
        assertEquals(0, gate.inFlight.value)
        assertEquals(0, gate.usersTracked)
    }

    @Test
    fun `a body that ends before it is complete gives the permit back`() = testApplication {
        application { module() }
        val s = site()
        val gate = UploadGate(maxTotal = 1, maxPerUser = 1).also { UploadLimits.gate = it }
        val release = CompletableDeferred<Unit>()
        var status: HttpStatusCode? = null

        val job = launchHalfUpload(s, release) { status = it }
        awaitInFlight(gate, 1)
        assertEquals(HttpStatusCode.TooManyRequests, garbageUpload(s.boss).status, "while it is being read the permit is taken")
        release.complete(Unit) // the body ends here, without its closing boundary
        awaitInFlight(gate, 0)

        job.join()
        assertEquals(HttpStatusCode.BadRequest, status)
        assertEquals(0, dsl.fetchCount(PHOTOS))
        assertEquals(HttpStatusCode.OK, upload(s.boss, s.reportId, jpeg).status, "the next upload goes through")
    }

    @Test
    fun `a body that never arrives is ended with 408 after the time limit and gives the permit back`() = testApplication {
        application { module() }
        val s = site()
        val gate = UploadGate(maxTotal = 1, maxPerUser = 1).also { UploadLimits.gate = it }
        UploadLimits.bodyTimeout = Duration.ofMillis(1500)
        val release = CompletableDeferred<Unit>() // never completed while the server waits
        var status: HttpStatusCode? = null

        val job = launchHalfUpload(s, release) { status = it }
        awaitInFlight(gate, 1)
        awaitInFlight(gate, 0) // the time limit is what ends it
        release.complete(Unit)
        job.join()

        assertEquals(HttpStatusCode.RequestTimeout, status)
        UploadLimits.bodyTimeout = originalTimeout
        assertEquals(HttpStatusCode.OK, upload(s.boss, s.reportId, jpeg).status, "the permit is back")
    }

    /**
     * A client that goes away in the middle of the body. The test engine of Ktor does not model a dropped connection (a
     * cancelled client leaves the server's call waiting), so this one is a real server on a free port and a real socket.
     */
    @Test
    fun `a client that closes the connection in the middle of the body gives the permit back`() = runBlocking<Unit> {
        val s = site()
        val gate = UploadGate(maxTotal = 1, maxPerUser = 1).also { UploadLimits.gate = it }
        val server = embeddedServer(Netty, port = 0) { module() }.start(wait = false)
        try {
            val port = server.engine.resolvedConnectors().first().port
            val partial = multipartStart(s.reportId).toByteArray() + jpeg.copyOf(200)
            val socket = Socket("127.0.0.1", port)
            socket.getOutputStream().apply {
                write(
                    ("POST /api/photos/upload HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${bearer(s.boss)}\r\n" +
                        "Content-Type: multipart/form-data; boundary=$boundary\r\nContent-Length: ${partial.size + 100_000}\r\n\r\n").toByteArray()
                )
                write(partial)
                flush()
            }
            awaitInFlight(gate, 1) // the server is waiting for the rest of the photo, with the permit

            socket.close() // the client goes away
            awaitInFlight(gate, 0)

            assertEquals(0, gate.usersTracked)
            assertEquals(0, dsl.fetchCount(PHOTOS))
        } finally {
            server.stop(100, 1000)
        }
    }

    /**
     * A refusal comes while the client is still sending a 5 MiB body that the server will not read. A real client must still
     * receive the answer (not a reset connection), or the person would see "network error" instead of the reason.
     */
    @Test
    fun `a client that is still sending a big body receives the refusal`() = runBlocking<Unit> {
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR).also { addMember(s.projectId, it) }
        UploadLimits.gate = UploadGate(maxTotal = 1, maxPerUser = 1)
        val server = embeddedServer(Netty, port = 0) { module() }.start(wait = false)
        try {
            val port = server.engine.resolvedConnectors().first().port
            val head = multipartStart(s.reportId).toByteArray()
            val file = ByteArray(5 * 1024 * 1024) { 0x41 }
            val body = head + file + "\r\n--$boundary--\r\n".toByteArray()
            val client = java.net.http.HttpClient.newHttpClient()
            val request = java.net.http.HttpRequest.newBuilder(java.net.URI("http://127.0.0.1:$port/api/photos/upload"))
                .header("Authorization", bearer(investor))
                .header("Content-Type", "multipart/form-data; boundary=$boundary")
                .POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(body))
                .build()

            val response = withContext(Dispatchers.IO) { client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString()) }

            assertEquals(403, response.statusCode(), response.body())
        } finally {
            server.stop(100, 1000)
        }
    }

    private fun ApplicationTestBuilder.launchHalfUpload(
        s: Site,
        release: CompletableDeferred<Unit>,
        onStatus: (HttpStatusCode) -> Unit = {},
    ) = kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
        runCatching {
            onStatus(
                client.post("/api/photos/upload") {
                    header(HttpHeaders.Authorization, bearer(s.boss))
                    setBody(halfUpload(s.reportId, release))
                }.status
            )
        }
    }

    // --- who may add a photo is decided before the body is read --------------------------------------

    @Test
    fun `a member who may not upload, and a stranger, are refused before the photo is read`() = testApplication {
        application { module() }
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR).also { addMember(s.projectId, it) }
        val stranger = createTestUser(role = Role.WORKER)
        // A file that would be a 400 if it were read and looked at: the refusal for the person comes first.
        val notAnImage = "this is not an image".toByteArray()

        assertEquals(HttpStatusCode.Forbidden, upload(investor, s.reportId, notAnImage).status)
        assertEquals(HttpStatusCode.Forbidden, upload(stranger, s.reportId, notAnImage).status)
        assertEquals(HttpStatusCode.BadRequest, upload(s.boss, s.reportId, notAnImage).status, "whoever may upload gets the answer about the file")
        assertEquals(0, dsl.fetchCount(PHOTOS))
    }

    @Test
    fun `an investor with a file over the size limit is refused for who they are, not read`() = testApplication {
        application { module() }
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR).also { addMember(s.projectId, it) }

        val response = upload(investor, s.reportId, ByteArray(5_500 * 1024) { 0xFF.toByte() })

        assertEquals(HttpStatusCode.Forbidden, response.status, response.bodyAsText())
    }

    @Test
    fun `the fields that name the entry must come before the file`() = testApplication {
        application { module() }
        val s = site()

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("photo", jpeg, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"p.jpg\"")
                })
                append("reportId", s.reportId)
            }
        ) { header(HttpHeaders.Authorization, bearer(s.boss)) }

        assertEquals(HttpStatusCode.BadRequest, response.status, response.bodyAsText())
        assertTrue(response.bodyAsText().contains("reportId"), response.bodyAsText())
        assertTrue(response.bodyAsText().contains("před"), "it says that the fields come first: ${response.bodyAsText()}")
        assertEquals(0, dsl.fetchCount(PHOTOS))
    }
}
