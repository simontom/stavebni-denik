package cz.stavebni.denik.plugins

import io.ktor.server.application.*
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.utils.io.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.io.readByteArray
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

/**
 * The limit on the size of a request body. It is Ktor's own plugin with one change (the copy of the body is flushed as it
 * goes), so what Ktor's plugin does has to be kept: refuse a body that announces too much, refuse one that delivers too much
 * without announcing it, leave the rest alone. And the reason for the change has its own test.
 */
class BoundedRequestBodyTest {

    private val limit = 100_000L

    /** A server with just this plugin and a route that reads the whole body and says how long it was. */
    private fun server() = embeddedServer(Netty, port = 0) {
        install(BoundedRequestBody) { bodyLimit { limit } }
        routing {
            post("/size") {
                call.respondText("read ${call.receiveChannel().readRemaining().readByteArray().size}")
            }
        }
    }.start(wait = false)

    private fun post(port: Int, path: String, request: (HttpRequest.Builder) -> HttpRequest.Builder): HttpResponse<String> =
        HttpClient.newHttpClient().send(
            request(HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path"))).build(),
            HttpResponse.BodyHandlers.ofString()
        )

    @Test
    fun `a body within the limit is read as it is`() = runBlocking<Unit> {
        val server = server()
        try {
            val port = server.engine.resolvedConnectors().first().port
            val response = withContext(Dispatchers.IO) {
                post(port, "/size") { it.POST(HttpRequest.BodyPublishers.ofByteArray(ByteArray(99_000) { 0x41 })) }
            }

            assertEquals(200, response.statusCode())
            assertEquals("read 99000", response.body())
        } finally {
            server.stop(100, 1000)
        }
    }

    @Test
    fun `a body that announces more than the limit is refused with 413`() = runBlocking<Unit> {
        val server = server()
        try {
            val port = server.engine.resolvedConnectors().first().port
            val response = withContext(Dispatchers.IO) {
                post(port, "/size") { it.POST(HttpRequest.BodyPublishers.ofByteArray(ByteArray(100_001) { 0x41 })) }
            }

            assertEquals(413, response.statusCode())
        } finally {
            server.stop(100, 1000)
        }
    }

    @Test
    fun `a body that delivers more than the limit without announcing its size is refused with 413`() = runBlocking<Unit> {
        val server = server()
        try {
            val port = server.engine.resolvedConnectors().first().port
            // No Content-Length: the client sends the body in chunks.
            val response = withContext(Dispatchers.IO) {
                post(port, "/size") { it.POST(HttpRequest.BodyPublishers.ofInputStream { ByteArrayInputStream(ByteArray(150_000) { 0x41 }) }) }
            }

            assertEquals(413, response.statusCode())
        } finally {
            server.stop(100, 1000)
        }
    }

    /**
     * Ktor's `RequestBodyLimit` copies the body through a channel that it never flushes, so everything behind it sees nothing of
     * a request until 1 MiB has arrived or the body has ended (measured on Ktor 3.6.0: 1,048,000 bytes and then silence reach
     * the handler never, 1,100,000 do). A handler could not read the fields at the start of an upload, nor tell a client
     * that has stopped sending from one that is slow. Here a client sends 5,000 bytes and then nothing: the handler has them.
     */
    @Test
    fun `the start of a body reaches the handler as it arrives, not when a mebibyte has piled up`() {
        val server = embeddedServer(Netty, port = 0) {
            install(BoundedRequestBody) { bodyLimit { 6L * 1024 * 1024 } }
            routing {
                post("/first") {
                    val buffer = ByteArray(8192)
                    call.respondText("first ${call.receiveChannel().readAvailable(buffer)}")
                }
            }
        }.start(wait = false)
        try {
            val port = runBlocking { server.engine.resolvedConnectors().first().port }
            Socket("127.0.0.1", port).use { socket ->
                socket.soTimeout = 10_000
                socket.tcpNoDelay = true
                socket.getOutputStream().apply {
                    write("POST /first HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5000000\r\n\r\n".toByteArray() + ByteArray(5_000) { 0x41 })
                    flush()
                }

                // The answer comes although 4,995,000 bytes of the announced body never arrive.
                assertEquals("HTTP/1.1 200 OK", socket.getInputStream().bufferedReader().readLine())
            }
        } finally {
            server.stop(100, 1000)
        }
    }
}
