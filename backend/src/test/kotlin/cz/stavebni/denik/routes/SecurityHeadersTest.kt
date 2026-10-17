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
        // A page talks to its own origin and to nobody else (the weather is typed by hand, nothing calls Open-Meteo).
        assertTrue(csp.contains("connect-src 'self';"), "$what: $csp")
        assertFalse(csp.contains("open-meteo"), "$what: $csp")

        // The device features the application never uses are switched off for the page and everything it embeds.
        // `camera=()` governs getUserMedia only: the photo field is a plain file input and still opens the camera app.
        assertEquals("camera=(), microphone=(), geolocation=()", headers["Permissions-Policy"], what)
        assertEquals("same-origin", headers["Cross-Origin-Opener-Policy"], what)
        // `same-site`, not `same-origin`: photos have to stay loadable from an SPA host listed in CORS_ALLOWED_ORIGINS.
        assertEquals("same-site", headers["Cross-Origin-Resource-Policy"], what)
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
        // Refused by the body limit before any route or login: still a response of this server.
        client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody("""{"nickname":"${"a".repeat(300_000)}","password":"x"}""")
        }.also {
            assertEquals(HttpStatusCode.PayloadTooLarge, it.status)
            it.assertHardened("body over the limit (413)")
        }
    }

    @Test
    fun `an answer to a CORS preflight carries the headers too`() = testApplication {
        System.setProperty("CORS_ALLOWED_ORIGINS", "https://spa.example")
        try {
            application { module() }

            val preflight = client.options("/api/projects") {
                header(HttpHeaders.Origin, "https://spa.example")
                header(HttpHeaders.AccessControlRequestMethod, "GET")
            }
            assertEquals("https://spa.example", preflight.headers[HttpHeaders.AccessControlAllowOrigin], "the preflight itself was answered")
            preflight.assertHardened("CORS preflight")
        } finally {
            System.clearProperty("CORS_ALLOWED_ORIGINS")
        }
    }

    @Test
    fun `the single page app is served with the same headers`() {
        val dir = Files.createTempDirectory("spa")
        Files.writeString(dir.resolve("index.html"), """<!doctype html><div id="root"></div>""")
        Files.createDirectories(dir.resolve("assets"))
        Files.writeString(dir.resolve("assets/app.js"), "console.log('app');")
        System.setProperty("STATIC_DIR", dir.toString())
        try {
            testApplication {
                application { module() }

                val index = client.get("/")
                assertEquals(HttpStatusCode.OK, index.status)
                index.assertHardened("index")
                // A route of the SPA that is not a file: the app is served and the headers are still there.
                val deepLink = client.get("/projects/123")
                assertEquals(HttpStatusCode.OK, deepLink.status)
                deepLink.assertHardened("deep link")
                // A real file of the build (script, stylesheet, image) is a static response, not the index page.
                val script = client.get("/assets/app.js")
                assertEquals(HttpStatusCode.OK, script.status)
                assertEquals("console.log('app');", script.bodyAsText())
                script.assertHardened("static file")
            }
        } finally {
            System.clearProperty("STATIC_DIR")
            // Only now, with the application stopped: Ktor watches the files it serves and reads one again when it changes,
            // so deleting the directory while the application runs can fail the test with a FileNotFoundException.
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
