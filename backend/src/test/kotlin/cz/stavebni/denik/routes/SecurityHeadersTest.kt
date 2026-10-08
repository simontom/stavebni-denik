package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.module
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.nio.file.Files

/**
 * The security headers as the Ktor server really sends them, on every kind of response. (The browser tests in `e2e/`
 * talk to the Vite development server, which sets its own headers; they say nothing about this server.)
 */
class SecurityHeadersTest : BaseIntegrationTest() {

    private fun HttpResponse.assertHardened(what: String) {
        assertEquals("nosniff", headers["X-Content-Type-Options"], what)
        assertEquals("DENY", headers["X-Frame-Options"], what)
        assertEquals("strict-origin-when-cross-origin", headers["Referrer-Policy"], what)
        val csp = headers["Content-Security-Policy"]
        assertNotNull(csp, "$what: Content-Security-Policy")
        for (directive in listOf("default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'")) {
            assertTrue(csp!!.contains(directive), "$what: CSP lacks $directive: $csp")
        }
        assertFalse(csp!!.contains("unsafe-eval"), "$what: $csp")
        assertFalse(Regex("""script-src[^;]*'unsafe-inline'""").containsMatchIn(csp), "$what: scripts must not be inline: $csp")
        // The weather service is the only external place a page may talk to.
        assertTrue(csp.contains("connect-src 'self' https://api.open-meteo.com;"), "$what: $csp")
    }

    @Test
    fun `every kind of API response carries the headers, errors included`() = testApplication {
        application { module() }

        client.get("/api/health").assertHardened("health (200)")
        client.get("/api/projects").also {
            assertEquals(HttpStatusCode.Unauthorized, it.status)
            it.assertHardened("no session (401)")
        }
        client.get("/api/no-such-route").assertHardened("unknown route (404)")
        client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody("""{"nickname":"nobody","password":"x"}""")
        }.assertHardened("wrong password (401)")
        client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            header("Sec-Fetch-Site", "cross-site")
            setBody("{}")
        }.also {
            assertEquals(HttpStatusCode.Forbidden, it.status)
            it.assertHardened("cross-site request (403)")
        }
    }

    @Test
    fun `the single page app is served with the same headers`() = testApplication {
        val dir = Files.createTempDirectory("spa")
        Files.writeString(dir.resolve("index.html"), """<!doctype html><div id="root"></div>""")
        System.setProperty("STATIC_DIR", dir.toString())
        try {
            application { module() }

            val index = client.get("/")
            assertEquals(HttpStatusCode.OK, index.status)
            index.assertHardened("index")
            // A route of the SPA that is not a file: the app is served and the headers are still there.
            val deepLink = client.get("/projects/123")
            assertEquals(HttpStatusCode.OK, deepLink.status)
            deepLink.assertHardened("deep link")
        } finally {
            System.clearProperty("STATIC_DIR")
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `strict transport security is sent in production only`() = testApplication {
        application { module() }
        assertNull(client.get("/api/health").headers["Strict-Transport-Security"], "plain HTTP development must not pin HTTPS")

        val production = mapOf("APP_ENV" to "production", "ALLOW_UNRELEASED_BUILD" to "true", "JWT_SECRET" to "x".repeat(48))
        val saved = production.keys.associateWith { System.getProperty(it) }
        production.forEach { (k, v) -> System.setProperty(k, v) }
        try {
            val hsts = client.get("/api/health").headers["Strict-Transport-Security"]
            assertNotNull(hsts, "production")
            assertTrue(hsts!!.contains("includeSubDomains") && Regex("max-age=\\d{7,}").containsMatchIn(hsts), hsts)
        } finally {
            saved.forEach { (k, v) -> if (v == null) System.clearProperty(k) else System.setProperty(k, v) }
        }
    }
}
