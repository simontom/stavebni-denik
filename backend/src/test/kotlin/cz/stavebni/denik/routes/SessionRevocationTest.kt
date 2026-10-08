package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.SESSIONS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.JwtService
import cz.stavebni.denik.services.SessionService
import cz.stavebni.denik.services.UserService
import cz.stavebni.denik.services.UpdateUserRequest
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.Duration
import java.time.OffsetDateTime
import java.util.UUID

/**
 * A token only names a session and a user. Whether it still works, and what its owner may do,
 * is decided by the database on every request.
 */
class SessionRevocationTest : BaseIntegrationTest() {

    /** An authenticated endpoint that every logged-in user may call. */
    private val anyUserEndpoint = "/api/projects"

    /** An endpoint for app admins only. */
    private val adminEndpoint = "/api/users"

    private suspend fun ApplicationTestBuilder.status(path: String, token: String): HttpStatusCode =
        client.get(path) { header(HttpHeaders.Authorization, "Bearer $token") }.status

    private suspend fun ApplicationTestBuilder.postAs(path: String, token: String): HttpStatusCode =
        client.post(path) {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody("{}")
        }.status

    private fun ApplicationTestBuilder.jsonClient() = createClient { install(ContentNegotiation) { json() } }

    /** Logs in through the API and returns the value of the jwt cookie. */
    private suspend fun ApplicationTestBuilder.login(nickname: String, password: String = "Password123!"): String {
        val response = jsonClient().post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(nickname = nickname, password = password))
        }
        assertEquals(HttpStatusCode.OK, response.status)
        return response.setCookie().first { it.name == "jwt" }.value
    }

    private suspend fun ApplicationTestBuilder.statusWithCookie(path: String, cookie: String): HttpStatusCode =
        client.get(path) { header(HttpHeaders.Cookie, "jwt=$cookie") }.status

    // --- ending access at once -----------------------------------------------------------------

    @Test
    fun `a deactivated user's token stops working at once`() = testApplication {
        application { module() }
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val worker = createTestUser(role = Role.WORKER)
        val adminToken = generateJwtToken(admin)
        val workerToken = generateJwtToken(worker)
        assertEquals(HttpStatusCode.OK, status(anyUserEndpoint, workerToken))

        assertEquals(HttpStatusCode.OK, postAs("/api/users/${worker.id}/deactivate", adminToken))

        assertEquals(HttpStatusCode.Unauthorized, status(anyUserEndpoint, workerToken))
    }

    @Test
    fun `a deleted user's token stops working at once`() = testApplication {
        application { module() }
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val worker = createTestUser(role = Role.WORKER)
        val workerToken = generateJwtToken(worker)

        val deleted = client.delete("/api/users/${worker.id}") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(admin)}")
        }
        assertEquals(HttpStatusCode.NoContent, deleted.status)

        assertEquals(HttpStatusCode.Unauthorized, status(anyUserEndpoint, workerToken))
    }

    @Test
    fun `reactivating an account does not bring its old sessions back`() = testApplication {
        application { module() }
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val worker = createTestUser(nickname = "reactivated_worker", role = Role.WORKER)
        val adminToken = generateJwtToken(admin)
        val oldToken = generateJwtToken(worker)

        assertEquals(HttpStatusCode.OK, postAs("/api/users/${worker.id}/deactivate", adminToken))
        assertEquals(HttpStatusCode.OK, postAs("/api/users/${worker.id}/activate", adminToken))

        assertEquals(HttpStatusCode.Unauthorized, status(anyUserEndpoint, oldToken), "the old session must stay dead")
        val fresh = login("reactivated_worker")
        assertEquals(HttpStatusCode.OK, statusWithCookie(anyUserEndpoint, fresh), "a new login works")
    }

    @Test
    fun `logout ends the session itself, not only the cookie`() = testApplication {
        application { module() }
        createTestUser(nickname = "logout_user", role = Role.WORKER)
        val cookie = login("logout_user")
        assertEquals(HttpStatusCode.OK, statusWithCookie(anyUserEndpoint, cookie))

        val logout = client.post("/api/auth/logout") { header(HttpHeaders.Cookie, "jwt=$cookie") }
        assertEquals(HttpStatusCode.OK, logout.status)

        // A copied token must be worthless after logout.
        assertEquals(HttpStatusCode.Unauthorized, statusWithCookie(anyUserEndpoint, cookie))
        assertNotNull(dsl.select(SESSIONS.REVOKEDAT).from(SESSIONS).fetchOne(SESSIONS.REVOKEDAT))
    }

    // --- rights come from the database, not from the token -------------------------------------

    @Test
    fun `a demoted admin has to log in again and then no longer is an admin`() = testApplication {
        application { module() }
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val other = createTestUser(nickname = "demoted_admin", role = Role.BOSS, isAdmin = true)
        val otherToken = generateJwtToken(other)
        assertEquals(HttpStatusCode.OK, status(adminEndpoint, otherToken))

        runBlocking { UserService.updateUser(admin, other.id, UpdateUserRequest(isAdmin = false)) }

        assertEquals(HttpStatusCode.Unauthorized, status(adminEndpoint, otherToken), "the old session ended")
        val fresh = login("demoted_admin")
        assertEquals(HttpStatusCode.Forbidden, statusWithCookie(adminEndpoint, fresh), "no longer an admin")
    }

    @Test
    fun `rights claimed inside the token are ignored`() = testApplication {
        application { module() }
        val worker = createTestUser(role = Role.WORKER, isAdmin = false)
        generateJwtToken(worker) // creates the worker's real session
        // A token with a valid signature that claims admin rights the user does not have.
        val inflated = JwtService.createToken(worker.copy(isAdmin = true, role = Role.BOSS), java.time.Instant.now().plusSeconds(3600))

        assertEquals(HttpStatusCode.Forbidden, status(adminEndpoint, inflated), "permissions follow the database")
    }

    // --- sessions that must not work ------------------------------------------------------------

    @Test
    fun `an expired session is refused even though the token has not expired`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.WORKER)
        dsl.insertInto(SESSIONS)
            .set(SESSIONS.ID, user.sessionId)
            .set(SESSIONS.USERID, user.id)
            .set(SESSIONS.EXPIRESAT, OffsetDateTime.now().minusMinutes(1))
            .execute()
        val token = JwtService.createToken(user, java.time.Instant.now().plusSeconds(3600))

        assertEquals(HttpStatusCode.Unauthorized, status(anyUserEndpoint, token))
    }

    @Test
    fun `a revoked session is refused`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.WORKER)
        val token = generateJwtToken(user)
        assertEquals(HttpStatusCode.OK, status(anyUserEndpoint, token))

        SessionService.revoke(dsl, user.sessionId)

        assertEquals(HttpStatusCode.Unauthorized, status(anyUserEndpoint, token))
    }

    @Test
    fun `a validly signed token for a session that does not exist is refused`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.WORKER) // no session row was ever created
        val token = JwtService.createToken(user, java.time.Instant.now().plusSeconds(3600))

        assertEquals(HttpStatusCode.Unauthorized, status(anyUserEndpoint, token))
    }

    @Test
    fun `a session cannot be used under another user's id`() = testApplication {
        application { module() }
        val victim = createTestUser(role = Role.BOSS, isAdmin = true)
        val attacker = createTestUser(role = Role.WORKER)
        generateJwtToken(attacker) // the attacker's own, valid session
        val mixed = JwtService.createToken(
            victim.copy(sessionId = attacker.sessionId), // the victim's id with the attacker's session
            java.time.Instant.now().plusSeconds(3600)
        )

        assertEquals(HttpStatusCode.Unauthorized, status(adminEndpoint, mixed))
    }

    // --- login ----------------------------------------------------------------------------------

    @Test
    fun `every login creates its own session that lasts 12 hours`() = testApplication {
        application { module() }
        val user = createTestUser(nickname = "twice_login", role = Role.WORKER)

        val first = login("twice_login")
        val second = login("twice_login")

        assertNotEquals(first, second)
        val sessions = dsl.selectFrom(SESSIONS).where(SESSIONS.USERID.eq(user.id)).fetch()
        assertEquals(2, sessions.size)
        for (session in sessions) {
            val lifetime = Duration.between(session.get(SESSIONS.CREATEDAT), session.get(SESSIONS.EXPIRESAT))
            assertTrue(lifetime > Duration.ofHours(11).plusMinutes(59) && lifetime < Duration.ofHours(12).plusMinutes(1), "lifetime was $lifetime")
        }
        // each cookie belongs to its own session
        assertEquals(HttpStatusCode.OK, statusWithCookie(anyUserEndpoint, first))
        assertEquals(HttpStatusCode.OK, statusWithCookie(anyUserEndpoint, second))
    }

    // --- the application always keeps an administrator ------------------------------------------

    @Test
    fun `the last active admin cannot be demoted, deactivated or deleted`() = runBlocking {
        val adminA = createTestUser(nickname = "admin_a", role = Role.BOSS, isAdmin = true)
        val adminB = createTestUser(nickname = "admin_b", role = Role.BOSS, isAdmin = true)

        // With two admins, one may be removed...
        UserService.setActive(adminA, adminB.id, active = false)

        // ...but then adminA is the last one. adminB's request started while it still was an admin
        // (adminB still holds the old SessionUser), so every attempt is refused by the guard itself.
        assertThrows<IllegalStateException> { runBlocking { UserService.setActive(adminB, adminA.id, active = false) } }
        assertThrows<IllegalStateException> { runBlocking { UserService.updateUser(adminB, adminA.id, UpdateUserRequest(isAdmin = false)) } }
        assertThrows<IllegalStateException> { runBlocking { UserService.deleteUser(adminB, adminA.id) } }

        val stillActive = UserService.getUser(dsl, adminA.id)
        assertTrue(stillActive.isActive && stillActive.isAdmin)
    }

    @Test
    fun `an admin can be demoted while another active admin remains`() = runBlocking {
        val adminA = createTestUser(nickname = "demote_a", role = Role.BOSS, isAdmin = true)
        val adminB = createTestUser(nickname = "demote_b", role = Role.BOSS, isAdmin = true)

        val updated = UserService.updateUser(adminA, adminB.id, UpdateUserRequest(isAdmin = false))

        assertFalse(updated.isAdmin)
    }
}
