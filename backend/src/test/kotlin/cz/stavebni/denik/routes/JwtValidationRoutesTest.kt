package cz.stavebni.denik.routes

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.module
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.Instant
import java.util.Base64
import java.util.Date
import java.util.UUID

/**
 * What the server does with tokens that are not the ones it issued. Every one of them has to end in 401, including a
 * token that is otherwise perfect: right user, right session, right claims.
 */
class JwtValidationRoutesTest : BaseIntegrationTest() {

    private fun claims(user: SessionUser, issuer: String = "stavebni_denik", expires: Instant = Instant.now().plusSeconds(3600)) =
        JWT.create()
            .withIssuer(issuer)
            .withClaim("id", user.id.toString())
            .withClaim("nickname", user.nickname)
            .withClaim("displayName", user.displayName)
            .withClaim("role", user.role.name)
            .withClaim("isAdmin", user.isAdmin)
            .withClaim("mustChangePwd", false)
            .withClaim("sessionId", user.sessionId.toString())
            .withExpiresAt(Date.from(expires))

    private suspend fun ApplicationTestBuilder.status(token: String, asCookie: Boolean = false): HttpStatusCode =
        client.get("/api/projects") {
            if (asCookie) header(HttpHeaders.Cookie, "jwt=$token") else header(HttpHeaders.Authorization, "Bearer $token")
        }.status

    private fun b64(text: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray())

    @Test
    fun `the genuine token works, in the header and as a cookie, so the refusals below mean something`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS)

        val token = generateJwtToken(user)

        assertEquals(HttpStatusCode.OK, status(token))
        assertEquals(HttpStatusCode.OK, status(token, asCookie = true))
    }

    @Test
    fun `a token signed with another key is refused although its claims and session are real`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS)
        generateJwtToken(user) // makes the session row exist

        val forged = claims(user).sign(Algorithm.HMAC256("not-the-servers-secret-0123456789abcdef"))

        assertEquals(HttpStatusCode.Unauthorized, status(forged))
        assertEquals(HttpStatusCode.Unauthorized, status(forged, asCookie = true))
    }

    @Test
    fun `a token with the algorithm none is refused`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS)
        generateJwtToken(user)
        val payload = """{"iss":"stavebni_denik","id":"${user.id}","nickname":"x","displayName":"x","role":"BOSS","isAdmin":true,"mustChangePwd":false,"sessionId":"${user.sessionId}","exp":${Instant.now().plusSeconds(3600).epochSecond}}"""

        val none = "${b64("""{"alg":"none","typ":"JWT"}""")}.${b64(payload)}."
        val noneNoDot = "${b64("""{"alg":"none","typ":"JWT"}""")}.${b64(payload)}"

        assertEquals(HttpStatusCode.Unauthorized, status(none))
        assertEquals(HttpStatusCode.Unauthorized, status(noneNoDot))
    }

    @Test
    fun `a token whose payload was edited after signing is refused`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.WORKER)
        val token = generateJwtToken(user)
        val (header, _, signature) = token.split(".")
        val promoted = b64("""{"iss":"stavebni_denik","id":"${user.id}","nickname":"x","displayName":"x","role":"BOSS","isAdmin":true,"mustChangePwd":false,"sessionId":"${user.sessionId}","exp":${Instant.now().plusSeconds(3600).epochSecond}}""")

        assertEquals(HttpStatusCode.Unauthorized, status("$header.$promoted.$signature"))
    }

    @Test
    fun `an expired token is refused even though its session is still open`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS)
        generateJwtToken(user)

        val expired = claims(user, expires = Instant.now().minusSeconds(60)).sign(Algorithm.HMAC256(cz.stavebni.denik.config.AppConfig.jwtSecret))

        assertEquals(HttpStatusCode.Unauthorized, status(expired))
    }

    @Test
    fun `a token from another issuer is refused`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS)
        generateJwtToken(user)

        val foreign = claims(user, issuer = "somebody-else").sign(Algorithm.HMAC256(cz.stavebni.denik.config.AppConfig.jwtSecret))

        assertEquals(HttpStatusCode.Unauthorized, status(foreign))
    }

    @Test
    fun `a perfect token for a session that does not exist is refused`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS)
        val ghostSession = user.copy(sessionId = UUID.randomUUID()) // no row in sessions

        val token = claims(ghostSession).sign(Algorithm.HMAC256(cz.stavebni.denik.config.AppConfig.jwtSecret))

        assertEquals(HttpStatusCode.Unauthorized, status(token))
    }

    @Test
    fun `a token that names another user's session is refused`() = testApplication {
        application { module() }
        val victim = createTestUser(role = Role.BOSS)
        val attacker = createTestUser(role = Role.WORKER)
        generateJwtToken(victim) // the victim's session exists

        // The attacker has the secret (worst case) and mixes his own id with the victim's session.
        val mixed = claims(attacker.copy(sessionId = victim.sessionId)).sign(Algorithm.HMAC256(cz.stavebni.denik.config.AppConfig.jwtSecret))

        assertEquals(HttpStatusCode.Unauthorized, status(mixed))
    }

    @Test
    fun `garbage in the header or the cookie is refused`() = testApplication {
        application { module() }

        for (junk in listOf("", "abc", "a.b.c", "....", "Bearer", "%00", "e30.e30.e30")) {
            // A header the HTTP layer cannot even parse is a 400 there; either way nothing is let in and nothing breaks.
            assertTrue(status(junk) in listOf(HttpStatusCode.Unauthorized, HttpStatusCode.BadRequest), "'$junk' as a bearer token")
            assertEquals(HttpStatusCode.Unauthorized, status(junk, asCookie = true), "'$junk' as a cookie")
        }
        val response = client.get("/api/projects")
        assertEquals(HttpStatusCode.Unauthorized, response.status, "no token at all")
        assertFalse(response.bodyAsText().contains("Exception"), "no internals in the answer")
    }
}
