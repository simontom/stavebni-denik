package cz.stavebni.denik.services

import com.github.tomakehurst.wiremock.WireMockServer
import com.github.tomakehurst.wiremock.client.WireMock.*
import com.github.tomakehurst.wiremock.core.WireMockConfiguration.options
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import java.security.MessageDigest

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class BreachedPasswordServiceTest {

    private lateinit var server: WireMockServer
    private val originalUrl = BreachedPasswordService.baseUrl

    private fun sha1(password: String) =
        MessageDigest.getInstance("SHA-1").digest(password.toByteArray()).joinToString("") { "%02X".format(it) }

    @BeforeAll
    fun start() {
        server = WireMockServer(options().dynamicPort())
        server.start()
    }

    @AfterAll
    fun stop() {
        server.stop()
        BreachedPasswordService.baseUrl = originalUrl
    }

    @BeforeEach
    fun point() {
        server.resetAll()
        BreachedPasswordService.baseUrl = "http://localhost:${server.port()}/range"
    }

    @AfterEach
    fun restore() {
        BreachedPasswordService.baseUrl = originalUrl
    }

    private fun answer(prefix: String, body: String) =
        server.stubFor(get(urlEqualTo("/range/$prefix")).willReturn(aResponse().withHeader("Content-Type", "text/plain").withBody(body)))

    @Test
    fun `a password whose hash suffix is listed is breached`() = runBlocking {
        val hash = sha1("Correct-Horse-1!")
        answer(hash.take(5), "0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n${hash.drop(5)}:41\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2")

        assertTrue(BreachedPasswordService.isBreached("Correct-Horse-1!"))
    }

    @Test
    fun `a password that is not listed is fine`() = runBlocking {
        val hash = sha1("Correct-Horse-1!")
        answer(hash.take(5), "0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2")

        assertFalse(BreachedPasswordService.isBreached("Correct-Horse-1!"))
    }

    @Test
    fun `padding entries with a count of zero are not matches`() = runBlocking {
        val hash = sha1("Correct-Horse-1!")
        answer(hash.take(5), "${hash.drop(5)}:0\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2")

        assertFalse(BreachedPasswordService.isBreached("Correct-Horse-1!"))
    }

    @Test
    fun `only the first five characters of the hash are sent, and padding is requested`() = runBlocking {
        val hash = sha1("Correct-Horse-1!")
        answer(hash.take(5), "")

        BreachedPasswordService.isBreached("Correct-Horse-1!")

        server.verify(
            1,
            getRequestedFor(urlEqualTo("/range/${hash.take(5)}")).withHeader("Add-Padding", equalTo("true"))
        )
        val sent = server.allServeEvents.map { it.request.url + it.request.headers.all().joinToString { h -> h.toString() } }.joinToString()
        assertFalse(sent.contains(hash.drop(5)), "the rest of the hash must not leave the server")
        assertFalse(sent.contains("Correct-Horse-1!"), "the password must not leave the server")
    }

    @Test
    fun `an unreachable, failing or garbled service accepts the password (fail open)`() = runBlocking {
        val hash = sha1("Correct-Horse-1!")

        server.stubFor(get(urlEqualTo("/range/${hash.take(5)}")).willReturn(aResponse().withStatus(500).withBody("boom")))
        assertFalse(BreachedPasswordService.isBreached("Correct-Horse-1!"))

        server.stubFor(get(urlEqualTo("/range/${hash.take(5)}")).willReturn(aResponse().withBody("<html>not a hash list</html>")))
        assertFalse(BreachedPasswordService.isBreached("Correct-Horse-1!"))

        BreachedPasswordService.baseUrl = "http://localhost:1/range" // nothing listens there
        assertFalse(BreachedPasswordService.isBreached("Correct-Horse-1!"))
    }

    @Test
    fun `a slow service does not hold the request up for long`() = runBlocking {
        val hash = sha1("Correct-Horse-1!")
        server.stubFor(get(urlEqualTo("/range/${hash.take(5)}")).willReturn(aResponse().withFixedDelay(5_000).withBody("${hash.drop(5)}:9")))

        val started = System.nanoTime()
        val breached = BreachedPasswordService.isBreached("Correct-Horse-1!")
        val seconds = (System.nanoTime() - started) / 1e9

        assertFalse(breached, "a timeout counts as 'not known to be breached'")
        assertTrue(seconds < 4, "gave up after about 2 s, took $seconds s")
    }

    @Test
    fun `with the check switched off nothing is sent`() = runBlocking {
        BreachedPasswordService.baseUrl = null

        assertFalse(BreachedPasswordService.isBreached("password"))
        assertEquals(0, server.allServeEvents.size)
    }
}
