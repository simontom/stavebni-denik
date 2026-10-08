package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/** The cross-site request guard in front of the real routes. */
class CrossSiteRoutesTest : BaseIntegrationTest() {

    private suspend fun ApplicationTestBuilder.badLogin(configure: HttpRequestBuilder.() -> Unit = {}): HttpResponse =
        client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody("""{"nickname":"nobody","password":"x"}""")
            configure()
        }

    @Test
    fun `a state-changing request from another site is refused, a same-origin one is let through`() = testApplication {
        application { module() }

        assertEquals(HttpStatusCode.Forbidden, badLogin { header("Sec-Fetch-Site", "cross-site") }.status)
        assertEquals(HttpStatusCode.Forbidden, badLogin { header("Sec-Fetch-Site", "same-site") }.status)
        // Let through means: the guard stepped aside and the login itself said no.
        assertEquals(HttpStatusCode.Unauthorized, badLogin { header("Sec-Fetch-Site", "same-origin") }.status)
        assertEquals(HttpStatusCode.Unauthorized, badLogin { header("Sec-Fetch-Site", "none") }.status)
        assertEquals(HttpStatusCode.Unauthorized, badLogin().status, "no browser headers: a script or a test")
    }

    @Test
    fun `the guard does not depend on how the path is spelled`() = testApplication {
        application { module() }

        // The router percent-decodes a path before it matches a route, so these reach /api/auth/login while the raw
        // text of the path does not start with /api/ (a guard that looked at the raw text would not see them).
        val spellings = listOf("/%61pi/auth/login", "/%61%70%69/auth/login", "/api/%61uth/login")
        for (path in spellings) {
            val response = client.post(path) {
                contentType(ContentType.Application.Json)
                header("Sec-Fetch-Site", "cross-site")
                setBody("""{"nickname":"nobody","password":"x"}""")
            }
            assertEquals(HttpStatusCode.Forbidden, response.status, "path $path")
        }
        // Control: from the same origin the very same spellings reach the login handler (wrong credentials -> 401),
        // so the 403 above is the guard and not a routing miss.
        for (path in spellings) {
            val sameOrigin = client.post(path) {
                contentType(ContentType.Application.Json)
                header("Sec-Fetch-Site", "same-origin")
                setBody("""{"nickname":"nobody","password":"x"}""")
            }
            assertEquals(HttpStatusCode.Unauthorized, sameOrigin.status, "path $path")
        }
    }

    @Test
    fun `a forged request does not reach a route even with a valid session cookie`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(user)
        val hashBefore = dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(user.id)).fetchOne(USERS.PASSWORDHASH)

        val response = client.post("/api/auth/change-password") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Cookie, "jwt=$token")
            header(HttpHeaders.Origin, "https://evil.example")
            header("Sec-Fetch-Site", "cross-site")
            setBody("""{"currentPassword":"Password123!","newPassword":"Evil-New-Password-1!"}""")
        }

        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertEquals(hashBefore, dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(user.id)).fetchOne(USERS.PASSWORDHASH))
    }

    @Test
    fun `without Sec-Fetch-Site the Origin has to match the host`() = testApplication {
        application { module() }

        assertEquals(HttpStatusCode.Forbidden, badLogin { header(HttpHeaders.Origin, "https://evil.example") }.status)
        assertEquals(HttpStatusCode.Forbidden, badLogin { header(HttpHeaders.Origin, "null") }.status)
        assertEquals(HttpStatusCode.Unauthorized, badLogin {
            header(HttpHeaders.Host, "denik.example")
            header(HttpHeaders.Origin, "https://denik.example")
        }.status)
    }

    @Test
    fun `reading is never blocked`() = testApplication {
        application { module() }

        val response = client.get("/api/health") { header("Sec-Fetch-Site", "cross-site") }

        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `an origin on the CORS allow list may make state-changing requests`() = testApplication {
        System.setProperty("CORS_ALLOWED_ORIGINS", "https://spa.example")
        try {
            application { module() }
            val allowed = badLogin {
                header(HttpHeaders.Origin, "https://spa.example")
                header("Sec-Fetch-Site", "cross-site")
            }
            val other = badLogin {
                header(HttpHeaders.Origin, "https://evil.example")
                header("Sec-Fetch-Site", "cross-site")
            }

            assertEquals(HttpStatusCode.Unauthorized, allowed.status)
            assertEquals(HttpStatusCode.Forbidden, other.status)
        } finally {
            System.clearProperty("CORS_ALLOWED_ORIGINS")
        }
    }
}
