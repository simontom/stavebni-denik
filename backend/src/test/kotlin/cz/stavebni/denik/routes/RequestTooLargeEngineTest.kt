package cz.stavebni.denik.routes

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.module
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.slf4j.LoggerFactory
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.net.Socket

/**
 * A request body that is too large is refused with `413` like every other answer of the application: through the same
 * security headers, and without an error in the log (an expected refusal that anybody can provoke must not write a stack trace
 * per request). The test engine of Ktor does not send a `Content-Length`, so none of this shows there: it goes through a real
 * Netty engine and raw sockets, with the length announced and with the body in chunks.
 */
class RequestTooLargeEngineTest : BaseIntegrationTest() {

    private val securityHeaders = listOf(
        "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Content-Security-Policy",
        "Permissions-Policy", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy",
    )

    private class Answer(val status: String, val headers: Map<String, String>, val body: String)

    /** Sends [request] on a fresh connection (closed after the answer) and reads the whole answer. */
    private fun ask(port: Int, request: ByteArray): Answer {
        Socket("127.0.0.1", port).use { socket ->
            socket.soTimeout = 15_000
            socket.tcpNoDelay = true
            socket.getOutputStream().apply { write(request); flush() }
            val reader = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1)
            val status = reader.readLine()
            val headers = linkedMapOf<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                headers[line.substringBefore(':').trim().lowercase()] = line.substringAfter(':').trim()
            }
            // Read as bytes (ISO-8859-1 maps them one to one) and decoded as what it is, UTF-8.
            return Answer(status, headers, String(reader.readText().toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8))
        }
    }

    private fun head(method: String, path: String, length: String, extra: String = "") =
        "$method $path HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\n$extra$length\r\n\r\n"

    /** Runs [block] against a real server, collecting what is logged at ERROR and what is printed to stderr. */
    private fun withServer(block: (port: Int) -> Unit): Pair<List<ILoggingEvent>, String> {
        val appender = ListAppender<ILoggingEvent>().also { it.start() }
        val root = LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME) as Logger
        root.addAppender(appender)
        val originalErr = System.err
        val captured = ByteArrayOutputStream()
        System.setErr(PrintStream(captured, true))
        val server = embeddedServer(Netty, port = 0) { module() }.start(wait = false)
        try {
            block(runBlocking { server.engine.resolvedConnectors().first().port })
        } finally {
            server.stop(100, 1000)
            System.setErr(originalErr)
            root.detachAppender(appender)
        }
        return appender.list.filter { it.level.isGreaterOrEqual(Level.ERROR) } to captured.toString()
    }

    private fun assertRefusedLikeAnyOtherAnswer(answer: Answer, what: String) {
        assertEquals("HTTP/1.1 413 Payload Too Large", answer.status, what)
        for (name in securityHeaders) assertTrue(answer.headers.containsKey(name.lowercase()), "$what: the answer lacks $name; it has ${answer.headers.keys}")
        assertTrue(answer.body.contains("příliš velký"), "$what: ${answer.body}")
    }

    @Test
    fun `a body that announces more than the limit is refused with the security headers and no error in the log`() {
        val answers = linkedMapOf<String, Answer>()
        val (errors, stderr) = withServer { port ->
            // JSON endpoint, before anybody is logged in; a GET with a body length; a route that does not exist; the upload.
            answers["login"] = ask(port, head("POST", "/api/auth/login", "Content-Length: 300000").toByteArray() + ByteArray(100) { 0x41 })
            answers["get"] = ask(port, head("GET", "/api/health", "Content-Length: 99999999").toByteArray())
            answers["unknown route"] = ask(port, head("POST", "/foo", "Content-Length: 300000").toByteArray() + ByteArray(100) { 0x41 })
            answers["upload"] = ask(port, head("POST", "/api/photos/upload", "Content-Length: ${7 * 1024 * 1024}").toByteArray())
        }

        answers.forEach { (what, answer) -> assertRefusedLikeAnyOtherAnswer(answer, what) }
        assertTrue(errors.isEmpty(), "expected refusals are not errors, logged: ${errors.map { it.formattedMessage }}")
        assertFalse(stderr.contains("Exception"), "no stack trace is printed for a refusal: $stderr")
    }

    @Test
    fun `a body that delivers more than the limit in chunks is refused with the security headers and no error in the log`() {
        val answers = linkedMapOf<String, Answer>()
        val (errors, stderr) = withServer { port ->
            fun chunked(path: String, bytes: Int): ByteArray {
                val chunk = ByteArray(10_000) { 0x41 }
                val out = ByteArrayOutputStream()
                out.write(head("POST", path, "Transfer-Encoding: chunked").toByteArray())
                repeat(bytes / chunk.size) {
                    out.write("${chunk.size.toString(16)}\r\n".toByteArray()); out.write(chunk); out.write("\r\n".toByteArray())
                }
                out.write("0\r\n\r\n".toByteArray())
                return out.toByteArray()
            }
            answers["login, 300 KB in chunks"] = ask(port, chunked("/api/auth/login", 300_000))
        }

        answers.forEach { (what, answer) -> assertRefusedLikeAnyOtherAnswer(answer, what) }
        assertTrue(errors.isEmpty(), "expected refusals are not errors, logged: ${errors.map { it.formattedMessage }}")
        assertFalse(stderr.contains("Exception"), "no stack trace is printed for a refusal: $stderr")
    }

    @Test
    fun `a request within the limits is answered as before, with the same headers`() {
        lateinit var answer: Answer
        withServer { port -> answer = ask(port, head("GET", "/api/health", "Content-Length: 0").toByteArray()) }

        assertEquals("HTTP/1.1 200 OK", answer.status)
        for (name in securityHeaders) assertTrue(answer.headers.containsKey(name.lowercase()), name)
    }
}
