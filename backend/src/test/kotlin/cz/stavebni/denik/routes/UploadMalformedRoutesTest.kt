package cz.stavebni.denik.routes

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.module
import cz.stavebni.denik.services.UploadGate
import cz.stavebni.denik.services.UploadLimits
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.http.content.ByteArrayContent
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.testing.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.slf4j.LoggerFactory
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.net.Socket

/**
 * A malformed multipart request is the client's mistake and is answered `400` with a generic Czech message, whatever is wrong
 * with it: no boundary, a boundary of 71 characters or with a letter outside ASCII, a part header that is empty or has no
 * colon. Nothing the client sent and nothing the parser said is repeated, nothing is printed to the log, no place in the gate
 * stays taken, and no job is left attached to the call (a child that never completes would stay for the life of the application).
 * Real requests on a real Netty engine: the test engine builds the multipart body itself and cannot send these.
 */
class UploadMalformedRoutesTest : BaseIntegrationTest() {

    private lateinit var originalGate: UploadGate

    @BeforeEach
    fun rememberGate() {
        originalGate = UploadLimits.gate
    }

    @AfterEach
    fun restoreGate() {
        UploadLimits.gate = originalGate
    }

    private class Answer(val status: String, val body: String)

    private fun request(token: String, contentType: String, body: ByteArray): ByteArray =
        ("POST /api/photos/upload HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer $token\r\n" +
            "Content-Type: ").toByteArray(Charsets.ISO_8859_1) + contentType.toByteArray(Charsets.UTF_8) +
            "\r\nContent-Length: ${body.size}\r\n\r\n".toByteArray() + body

    private fun ask(port: Int, bytes: ByteArray): Answer {
        Socket("127.0.0.1", port).use { socket ->
            socket.soTimeout = 15_000
            socket.getOutputStream().apply { write(bytes); flush() }
            val reader = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1)
            val status = reader.readLine()
            while (true) if ((reader.readLine() ?: break).isEmpty()) break
            return Answer(status, String(reader.readText().toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8))
        }
    }

    private val secret = "SECRET-CLIENT-TEXT-1234"

    private fun part(headers: String, value: String = "x") = "--b\r\n$headers\r\n\r\n$value\r\n--b--\r\n".toByteArray()

    /**
     * `readUpload` attaches the parser to the call with a job that never completes by itself, and a boundary the parser
     * refuses makes it throw before it has returned anything. If that job is not cancelled the handler's coroutine waits for
     * it for ever. Ktor's test engine fails a test that ends with a coroutine still running (`UncompletedCoroutinesError`,
     * after a minute), which is what finds it; a real engine cancels the call when the answer is out and hides it.
     */
    @Test
    fun `a malformed multipart request leaves no coroutine behind`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val cases = listOf(
            "no boundary" to ("multipart/form-data" to part("Content-Disposition: form-data; name=\"reportId\"")),
            "a boundary of 71 characters" to ("multipart/form-data; boundary=" + "a".repeat(71) to part("Content-Disposition: form-data; name=\"reportId\"")),
            "an empty Content-Disposition" to ("multipart/form-data; boundary=b" to part("Content-Disposition:")),
            "a part header without a colon" to ("multipart/form-data; boundary=b" to part("Content-Disposition form-data; name=\"reportId\"")),
        )

        for ((what, request) in cases) {
            val (contentType, body) = request
            val response = client.post("/api/photos/upload") {
                header(HttpHeaders.Authorization, "Bearer $token")
                setBody(ByteArrayContent(body, ContentType.parse(contentType)))
            }

            assertEquals(HttpStatusCode.BadRequest, response.status, "$what: ${response.bodyAsText()}")
        }
    }

    @Test
    fun `every kind of malformed multipart request is a 400 that says nothing of what was sent, and leaves nothing behind`() {
        val boss = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)
        val gate = UploadGate(maxBodies = 4, maxPerUser = 2).also { UploadLimits.gate = it }
        val cases = linkedMapOf(
            "no boundary" to request(token, "multipart/form-data", part("Content-Disposition: form-data; name=\"reportId\"")),
            "a boundary of 71 characters" to request(token, "multipart/form-data; boundary=" + "a".repeat(71), part("Content-Disposition: form-data; name=\"reportId\"")),
            "a boundary with a letter outside ASCII" to request(token, "multipart/form-data; boundary=ěščřž", part("Content-Disposition: form-data; name=\"reportId\"")),
            "an empty boundary" to request(token, "multipart/form-data; boundary=", part("Content-Disposition: form-data; name=\"reportId\"")),
            "an empty Content-Disposition" to request(token, "multipart/form-data; boundary=b", part("Content-Disposition:")),
            "a part header without a colon" to request(token, "multipart/form-data; boundary=b", part("Content-Disposition form-data; name=\"reportId\" $secret")),
            "a part header that is only a word" to request(token, "multipart/form-data; boundary=b", part(secret)),
            "no content type at all" to ("POST /api/photos/upload HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer $token\r\nContent-Length: 5\r\n\r\nhello").toByteArray(),
            "not multipart" to request(token, "application/json", "{\"reportId\":\"$secret\"}".toByteArray()),
        )

        val appender = ListAppender<ILoggingEvent>().also { it.start() }
        val root = LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME) as Logger
        root.addAppender(appender)
        val originalErr = System.err
        val stderr = ByteArrayOutputStream()
        System.setErr(PrintStream(stderr, true))
        val server = embeddedServer(Netty, port = 0) { module() }.start(wait = false)
        val answers = linkedMapOf<String, Answer>()
        try {
            val port = runBlocking { server.engine.resolvedConnectors().first().port }
            for ((what, bytes) in cases) answers[what] = ask(port, bytes)
            runBlocking {
                withTimeout(10_000) { gate.uploads.first { it == 0 } }
            }
        } finally {
            server.stop(100, 1000)
            System.setErr(originalErr)
            root.detachAppender(appender)
        }

        for ((what, answer) in answers) {
            assertEquals("HTTP/1.1 400 Bad Request", answer.status, "$what: ${answer.body}")
            assertFalse(answer.body.contains(secret), "$what: what the client sent is not repeated: ${answer.body}")
            assertFalse(Regex("Failed to parse|Expected|boundary|Exception|NoSuchElement|shouldn't be longer", RegexOption.IGNORE_CASE).containsMatchIn(answer.body), "$what: nothing the parser said: ${answer.body}")
            assertTrue(answer.body.contains("Neplatný požadavek"), "$what: a generic Czech message: ${answer.body}")
        }
        assertEquals(0, gate.uploads.value)
        assertEquals(0, gate.bodies.value)
        assertEquals(0, gate.usersTracked)
        val errors = appender.list.filter { it.level.isGreaterOrEqual(Level.ERROR) }
        assertTrue(errors.isEmpty(), "a malformed request is not an error of the server: ${errors.map { it.formattedMessage }}")
        assertFalse(stderr.toString().contains("Exception"), "no stack trace is printed: $stderr")
    }
}
