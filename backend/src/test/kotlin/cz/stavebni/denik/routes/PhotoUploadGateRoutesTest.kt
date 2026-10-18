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
import kotlinx.coroutines.CoroutineScope
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
 * The limits on uploads in flight (backlog A5, N4), in two stages: an upload in progress per user, taken on arrival, and a
 * body in memory for the whole server, taken only once the upload is **authorised** (when its file part arrives and the
 * person is known to be allowed to add a photo to that entry). Refusals are immediate (`429`, `503`); the permits are given
 * back on every way an upload can end, because a permit that leaks is a self-inflicted denial of service: success, a refusal,
 * an error, a body that ends early, a body or a start that never arrives, a client that drops the connection.
 */
class PhotoUploadGateRoutesTest : BaseIntegrationTest() {

    private val boundary = "gate-test-boundary"
    private lateinit var originalGate: UploadGate
    private lateinit var originalBodyTimeout: Duration
    private lateinit var originalPreFileTimeout: Duration

    @BeforeEach
    fun rememberLimits() {
        originalGate = UploadLimits.gate
        originalBodyTimeout = UploadLimits.bodyTimeout
        originalPreFileTimeout = UploadLimits.preFileTimeout
    }

    @AfterEach
    fun restoreLimits() {
        UploadLimits.gate = originalGate
        UploadLimits.bodyTimeout = originalBodyTimeout
        UploadLimits.preFileTimeout = originalPreFileTimeout
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

    /** A multipart body that is not multipart: had the server tried to read it, the answer would be a 400. */
    private suspend fun ApplicationTestBuilder.garbageUpload(user: SessionUser): HttpResponse =
        client.post("/api/photos/upload") {
            header(HttpHeaders.Authorization, bearer(user))
            contentType(ContentType.MultiPart.FormData.withParameter("boundary", boundary))
            setBody("this is not a multipart body at all")
        }

    private fun fieldPart(reportId: String) = "--$boundary\r\nContent-Disposition: form-data; name=\"reportId\"\r\n\r\n$reportId\r\n"

    private fun filePartHeader() =
        "--$boundary\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"p.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"

    /**
     * An upload that stops half way: the field that names the entry and then, if [fileBytes] is given, the file part with that
     * many bytes of it. Then it waits for [release] and ends, without the closing boundary. Without [fileBytes] the file
     * part never comes: the client has said what the upload is for and then nothing.
     */
    private fun stalledUpload(reportId: String, fileBytes: Int?, release: CompletableDeferred<Unit>) =
        object : OutgoingContent.WriteChannelContent() {
            override val contentType: ContentType = ContentType.MultiPart.FormData.withParameter("boundary", boundary)
            override suspend fun writeTo(channel: ByteWriteChannel) {
                channel.writeStringUtf8(fieldPart(reportId))
                if (fileBytes != null) {
                    channel.writeStringUtf8(filePartHeader())
                    channel.writeFully(ByteArray(fileBytes) { 0x41 })
                }
                channel.flush()
                release.await()
                channel.flushAndClose()
            }
        }

    private fun ApplicationTestBuilder.launchUpload(user: SessionUser, content: OutgoingContent, status: CompletableDeferred<HttpStatusCode>) =
        CoroutineScope(Dispatchers.IO).launch {
            try {
                status.complete(client.post("/api/photos/upload") {
                    header(HttpHeaders.Authorization, bearer(user))
                    setBody(content)
                }.status)
            } catch (e: Throwable) {
                status.completeExceptionally(e)
            }
        }

    private suspend fun awaitUploads(gate: UploadGate, expected: Int) {
        withTimeout(20_000) { gate.uploads.first { it == expected } }
    }

    private suspend fun awaitBodies(gate: UploadGate, expected: Int) {
        withTimeout(20_000) { gate.bodies.first { it == expected } }
    }

    // --- refusals, before a byte is read -------------------------------------------------------------

    @Test
    fun `a user who has the permitted number of uploads in progress is refused with 429 and a wait, before the body is read`() = testApplication {
        application { module() }
        val s = site()
        val gate = UploadGate(maxBodies = 10, maxPerUser = 2).also { UploadLimits.gate = it }
        val held = List(2) { gate.tryEnter(s.boss.id)!! }

        val response = garbageUpload(s.boss)

        assertEquals(HttpStatusCode.TooManyRequests, response.status, "429, not the 400 that reading the garbage would give: ${response.bodyAsText()}")
        assertNotNull(response.headers[HttpHeaders.RetryAfter], "it says when to come back")
        assertTrue(response.bodyAsText().contains("Právě se nahrává"), response.bodyAsText())
        assertEquals(0, dsl.fetchCount(PHOTOS))
        assertEquals(0, dsl.fetchCount(RATE_LIMIT_ATTEMPTS), "a request that was not even looked at is not charged to the user's volume limit")
        held.forEach { it.close() }
    }

    @Test
    fun `when the server holds all the bodies it may, a person who may upload is refused with 503, UPLOAD_BUSY and a wait`() = testApplication {
        application { module() }
        val s = site()
        val gate = UploadGate(maxBodies = 2, maxPerUser = 2).also { UploadLimits.gate = it }
        val held = List(2) { gate.tryTakeBody()!! }

        val response = upload(s.boss, s.reportId)

        assertEquals(HttpStatusCode.ServiceUnavailable, response.status, response.bodyAsText())
        assertEquals(UploadLimits.RETRY_AFTER_SECONDS.toString(), response.headers[HttpHeaders.RetryAfter])
        assertTrue(response.bodyAsText().contains("UPLOAD_BUSY"), response.bodyAsText())
        assertEquals(0, dsl.fetchCount(PHOTOS))
        awaitUploads(gate, 0)
        held.forEach { it.close() }
        assertEquals(HttpStatusCode.OK, upload(s.boss, s.reportId).status, "with room again the upload goes through")
    }

    @Test
    fun `a person who may not upload is refused for who they are, even when the server has no place for a body`() = testApplication {
        application { module() }
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR).also { addMember(s.projectId, it) }
        val stranger = createTestUser(role = Role.WORKER)
        UploadLimits.gate = UploadGate(maxBodies = 0, maxPerUser = 2) // not one body place, for anybody

        assertEquals(HttpStatusCode.Forbidden, upload(investor, s.reportId).status, "not 503: they were never going to be given a place")
        assertEquals(HttpStatusCode.Forbidden, upload(stranger, s.reportId).status)
        assertEquals(HttpStatusCode.ServiceUnavailable, upload(s.boss, s.reportId).status, "whoever may upload is told the server is full")
    }

    // --- a stall before the file part: it must not cost the people who work on site their place ----------

    @Test
    fun `a stranger who stalls before the file part takes no place for a body and cannot block a member`() = testApplication {
        application { module() }
        val s = site()
        val stranger = createTestUser(role = Role.WORKER) // signed in, but not a member of the project
        val gate = UploadGate(maxBodies = 1, maxPerUser = 2).also { UploadLimits.gate = it }
        val release = CompletableDeferred<Unit>()
        val strangerStatus = CompletableDeferred<HttpStatusCode>()

        val job = launchUpload(stranger, stalledUpload(s.reportId, fileBytes = null, release), strangerStatus)
        awaitUploads(gate, 1) // they are in progress, and have said nothing about a file
        assertEquals(0, gate.bodies.value, "no place for a body is held for somebody who has not been shown to be allowed")

        val member = upload(s.boss, s.reportId)

        assertEquals(HttpStatusCode.OK, member.status, "the one place of the server is the member's: ${member.bodyAsText()}")
        release.complete(Unit)
        job.join()
        assertEquals(HttpStatusCode.BadRequest, strangerStatus.await(), "a body that ends without a file")
        awaitUploads(gate, 0)
        assertEquals(0, gate.bodies.value)
    }

    @Test
    fun `a start that never shows what the upload is for is ended with 408 after the short deadline, and gives its place back`() = testApplication {
        application { module() }
        val s = site()
        val gate = UploadGate(maxBodies = 1, maxPerUser = 1).also { UploadLimits.gate = it }
        UploadLimits.preFileTimeout = Duration.ofMillis(500) // a controllable deadline: the real one is 30 s
        val release = CompletableDeferred<Unit>() // never completed while the server waits
        val status = CompletableDeferred<HttpStatusCode>()

        val job = launchUpload(s.boss, stalledUpload(s.reportId, fileBytes = null, release), status)
        awaitUploads(gate, 1)
        awaitUploads(gate, 0) // the short deadline is what ends it
        release.complete(Unit)
        job.join()

        assertEquals(HttpStatusCode.RequestTimeout, status.await())
        assertEquals(0, gate.bodies.value, "it never had a place for a body")
        UploadLimits.preFileTimeout = originalPreFileTimeout
        assertEquals(HttpStatusCode.OK, upload(s.boss, s.reportId).status, "the place is back")
    }

    // --- every way out gives the places back ---------------------------------------------------------

    @Test
    fun `the places are given back after a success, a refusal and every kind of error`() = testApplication {
        application { module() }
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR).also { addMember(s.projectId, it) }
        val gate = UploadGate(maxBodies = 1, maxPerUser = 1).also { UploadLimits.gate = it }

        // Each of these would leave the one place taken if some path forgot to give it back, and the next one would fail.
        val outcomes = listOf(
            "ok" to upload(s.boss, s.reportId).status,
            "garbage body" to garbageUpload(s.boss).status,
            "not an image" to upload(s.boss, s.reportId, "text".toByteArray()).status,
            "no such entry" to upload(s.boss, UUID.randomUUID().toString()).status,
            "a role that may not upload" to upload(investor, s.reportId).status,
            "file over 5 MiB" to upload(s.boss, s.reportId, ByteArray(5_500 * 1024) { 0xFF.toByte() }).status,
            "body over the request limit" to upload(s.boss, s.reportId, ByteArray(7 * 1024 * 1024) { 0x41 }).status,
            "ok again" to upload(s.boss, s.reportId).status,
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
        awaitUploads(gate, 0)
        awaitBodies(gate, 0)
        assertEquals(0, gate.usersTracked)
    }

    @Test
    fun `a body that ends before it is complete gives both places back`() = testApplication {
        application { module() }
        val s = site()
        val gate = UploadGate(maxBodies = 1, maxPerUser = 1).also { UploadLimits.gate = it }
        val release = CompletableDeferred<Unit>()
        val status = CompletableDeferred<HttpStatusCode>()

        val job = launchUpload(s.boss, stalledUpload(s.reportId, fileBytes = 200, release), status)
        awaitBodies(gate, 1) // authorised, and now reading the file
        assertEquals(HttpStatusCode.TooManyRequests, garbageUpload(s.boss).status, "while it is being read its place is taken")
        release.complete(Unit) // the body ends here, without its closing boundary
        awaitBodies(gate, 0)
        awaitUploads(gate, 0)

        job.join()
        assertEquals(HttpStatusCode.BadRequest, status.await())
        assertEquals(0, dsl.fetchCount(PHOTOS))
        assertEquals(HttpStatusCode.OK, upload(s.boss, s.reportId).status, "the next upload goes through")
    }

    @Test
    fun `a file that never arrives in full is ended with 408 after the time limit and gives both places back`() = testApplication {
        application { module() }
        val s = site()
        val gate = UploadGate(maxBodies = 1, maxPerUser = 1).also { UploadLimits.gate = it }
        UploadLimits.bodyTimeout = Duration.ofMillis(1500)
        val release = CompletableDeferred<Unit>() // never completed while the server waits
        val status = CompletableDeferred<HttpStatusCode>()

        val job = launchUpload(s.boss, stalledUpload(s.reportId, fileBytes = 200, release), status)
        awaitBodies(gate, 1)
        awaitBodies(gate, 0) // the time limit is what ends it
        awaitUploads(gate, 0)
        release.complete(Unit)
        job.join()

        assertEquals(HttpStatusCode.RequestTimeout, status.await())
        UploadLimits.bodyTimeout = originalBodyTimeout
        assertEquals(HttpStatusCode.OK, upload(s.boss, s.reportId).status, "the places are back")
    }

    // --- a real server and a real socket: what the test engine does not model -----------------------

    private fun startServer() = embeddedServer(Netty, port = 0) { module() }.start(wait = false)

    private fun rawUploadStart(port: Int, token: String, reportId: String, fileBytes: Int, declaredExtra: Int = 100_000): Socket {
        val partial = (fieldPart(reportId) + filePartHeader()).toByteArray() + ByteArray(fileBytes) { 0x41 }
        val socket = Socket("127.0.0.1", port)
        socket.tcpNoDelay = true
        socket.getOutputStream().apply {
            write(
                ("POST /api/photos/upload HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer $token\r\n" +
                    "Content-Type: multipart/form-data; boundary=$boundary\r\nContent-Length: ${partial.size + declaredExtra}\r\n\r\n").toByteArray() + partial
            )
            flush()
        }
        return socket
    }

    /**
     * What a client that has sent only the start of its body is answered. The body of a request reaches the handler as it
     * arrives (the body limit of the application must not hold a copy back, see `BoundedRequestBody`), so an upload that is
     * refused for who is asking is refused at once, with the rest of the file still to come. 200 bytes of it are all this
     * client sends, and then silence.
     */
    @Test
    fun `a refusal for who is asking is answered while the client has sent only the start of its body`() = runBlocking<Unit> {
        val s = site()
        val investor = createTestUser(role = Role.INVESTOR).also { addMember(s.projectId, it) }
        UploadLimits.gate = UploadGate(maxBodies = 8, maxPerUser = 2)
        val server = startServer()
        try {
            val port = server.engine.resolvedConnectors().first().port
            rawUploadStart(port, generateJwtToken(investor).removePrefix("Bearer "), s.reportId, fileBytes = 200).use { socket ->
                socket.soTimeout = 10_000
                val statusLine = withContext(Dispatchers.IO) { socket.getInputStream().bufferedReader().readLine() }

                assertEquals("HTTP/1.1 403 Forbidden", statusLine, "the answer comes without waiting for the rest of the body")
            }
        } finally {
            server.stop(100, 1000)
        }
    }

    @Test
    fun `a client that closes the connection in the middle of the file gives both places back`() = runBlocking<Unit> {
        val s = site()
        val gate = UploadGate(maxBodies = 1, maxPerUser = 1).also { UploadLimits.gate = it }
        val server = startServer()
        try {
            val port = server.engine.resolvedConnectors().first().port
            val socket = rawUploadStart(port, generateJwtToken(s.boss), s.reportId, fileBytes = 200)
            awaitBodies(gate, 1) // authorised, and the server is waiting for the rest of the photo, with its place

            socket.close() // the client goes away
            awaitBodies(gate, 0)
            awaitUploads(gate, 0)

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
        UploadLimits.gate = UploadGate(maxBodies = 1, maxPerUser = 1)
        val server = startServer()
        try {
            val port = server.engine.resolvedConnectors().first().port
            val head = (fieldPart(s.reportId) + filePartHeader()).toByteArray()
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

    @Test
    fun `a text field of several megabytes is refused as too long without being buffered, even for a stranger`() = testApplication {
        application { module() }
        val s = site()
        val stranger = createTestUser(role = Role.WORKER)

        val response = client.submitFormWithBinaryData(
            url = "/api/photos/upload",
            formData = formData {
                append("reportId", "7".repeat(5 * 1024 * 1024))
                append("photo", jpeg, Headers.build {
                    append(HttpHeaders.ContentType, "image/jpeg")
                    append(HttpHeaders.ContentDisposition, "filename=\"p.jpg\"")
                })
            }
        ) { header(HttpHeaders.Authorization, bearer(stranger)) }

        assertEquals(HttpStatusCode.BadRequest, response.status, response.bodyAsText())
        assertTrue(response.bodyAsText().contains("too long"), response.bodyAsText())
        assertEquals(0, dsl.fetchCount(PHOTOS))
    }
}
