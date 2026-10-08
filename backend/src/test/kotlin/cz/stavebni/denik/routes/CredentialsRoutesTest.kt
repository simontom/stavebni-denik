package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/** Login limits, password change, the temporary-password gate and the administrator's password reset. */
class CredentialsRoutesTest : BaseIntegrationTest() {

    private val strongPassword = "Nov3-Heslo-Pro-Test!"

    private suspend fun ApplicationTestBuilder.login(
        nickname: String,
        password: String,
        headers: Map<String, String> = emptyMap(),
    ): HttpResponse = client.post("/api/auth/login") {
        contentType(ContentType.Application.Json)
        headers.forEach { (k, v) -> header(k, v) }
        setBody("""{"nickname":${JsonPrimitive(nickname)},"password":${JsonPrimitive(password)}}""")
    }

    private suspend fun ApplicationTestBuilder.changePassword(token: String, current: String, new: String): HttpResponse =
        client.post("/api/auth/change-password") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Authorization, "Bearer $token")
            setBody("""{"currentPassword":"$current","newPassword":"$new"}""")
        }

    private suspend fun ApplicationTestBuilder.get(token: String, path: String): HttpResponse =
        client.get(path) { header(HttpHeaders.Authorization, "Bearer $token") }

    private fun tokenFrom(response: HttpResponse): String =
        response.headers[HttpHeaders.SetCookie]!!.substringAfter("jwt=").substringBefore(";")

    private fun failuresRecorded(): Int = dsl.selectCount().from(RATE_LIMIT_ATTEMPTS).fetchOne(0, Int::class.java)!!

    private fun auditRows(action: String): List<String> =
        dsl.fetch("select * from audit_log where action = ?", action).map { it.formatJSON() }

    // ---------------------------------------------------------------- login: what an answer reveals

    @Test
    fun `unknown names, wrong passwords and deactivated accounts get the same answer`() = testApplication {
        application { module() }
        createTestUser(nickname = "known_user", rawPassword = "Correct-Pass-1!")
        createTestUser(nickname = "gone_user", rawPassword = "Correct-Pass-1!")
        dsl.update(USERS).set(USERS.ISACTIVE, false).where(USERS.NICKNAME.eq("gone_user")).execute()

        val unknown = login("nobody_here", "Correct-Pass-1!")
        val wrong = login("known_user", "Wrong-Pass-1!")
        val deactivated = login("gone_user", "Correct-Pass-1!")

        assertEquals(HttpStatusCode.Unauthorized, unknown.status)
        assertEquals(HttpStatusCode.Unauthorized, wrong.status)
        assertEquals(HttpStatusCode.Unauthorized, deactivated.status)
        assertEquals(unknown.bodyAsText(), wrong.bodyAsText())
        assertEquals(unknown.bodyAsText(), deactivated.bodyAsText())
    }

    @Test
    fun `malformed credentials are refused without being counted as failed attempts`() = testApplication {
        application { module() }

        assertEquals(HttpStatusCode.BadRequest, login("", "x").status)
        assertEquals(HttpStatusCode.BadRequest, login("someone", "").status)
        assertEquals(HttpStatusCode.BadRequest, login("someone", "p".repeat(257)).status)
        assertEquals(HttpStatusCode.BadRequest, login("n".repeat(129), "x").status)
        assertEquals(0, failuresRecorded())
    }

    // ---------------------------------------------------------------- login: rate limits

    @Test
    fun `an account name is locked after 20 failures, even for the right password, and other names are not`() = testApplication {
        application { module() }
        createTestUser(nickname = "victim", rawPassword = "Correct-Pass-1!")
        createTestUser(nickname = "bystander", rawPassword = "Correct-Pass-1!")

        repeat(20) { assertEquals(HttpStatusCode.Unauthorized, login("victim", "Wrong-Pass-1!").status) }

        val locked = login("victim", "Correct-Pass-1!")
        assertEquals(HttpStatusCode.TooManyRequests, locked.status)
        val retryAfter = locked.headers[HttpHeaders.RetryAfter]?.toLong()
        assertNotNull(retryAfter, "a 429 names the wait")
        assertTrue(retryAfter!! in 1..900, "wait within the 15 minute window, was $retryAfter")
        assertTrue(locked.bodyAsText().contains("Zkuste to znovu"))

        assertEquals(HttpStatusCode.OK, login("bystander", "Correct-Pass-1!").status)
    }

    @Test
    fun `an address is locked after 30 failures and a successful login does not reset the count`() = testApplication {
        application { module() }
        createTestUser(nickname = "real_user", rawPassword = "Correct-Pass-1!")

        // 29 failures against different names (so no single name is locked), then a success, then one more failure.
        repeat(29) { i -> assertEquals(HttpStatusCode.Unauthorized, login("guess_$i", "Wrong-Pass-1!").status) }
        assertEquals(HttpStatusCode.OK, login("real_user", "Correct-Pass-1!").status)
        assertEquals(HttpStatusCode.Unauthorized, login("guess_last", "Wrong-Pass-1!").status)

        // 30 failures from this address: the next try is refused, whoever tries and with whatever password.
        assertEquals(HttpStatusCode.TooManyRequests, login("real_user", "Correct-Pass-1!").status)
    }

    @Test
    fun `client address headers are ignored unless a trusted proxy header is configured`() = testApplication {
        application { module() }
        createTestUser(nickname = "real_user", rawPassword = "Correct-Pass-1!")

        // The caller invents a new address for every attempt; with no trusted header they all count for one peer.
        repeat(30) { i ->
            login("guess_$i", "Wrong-Pass-1!", mapOf("X-Forwarded-For" to "10.0.0.$i", "Fly-Client-IP" to "10.1.0.$i"))
        }
        val refused = login("real_user", "Correct-Pass-1!", mapOf("X-Forwarded-For" to "10.9.9.9", "Fly-Client-IP" to "10.8.8.8"))
        assertEquals(HttpStatusCode.TooManyRequests, refused.status)
    }

    @Test
    fun `behind a configured proxy header every client address has its own limit`() = testApplication {
        application { module() }
        createTestUser(nickname = "real_user", rawPassword = "Correct-Pass-1!")
        System.setProperty("CLIENT_IP_HEADER", "Fly-Client-IP")
        try {
            repeat(30) { i -> login("guess_$i", "Wrong-Pass-1!", mapOf("Fly-Client-IP" to "203.0.113.5")) }

            assertEquals(HttpStatusCode.TooManyRequests, login("real_user", "Correct-Pass-1!", mapOf("Fly-Client-IP" to "203.0.113.5")).status)
            assertEquals(HttpStatusCode.OK, login("real_user", "Correct-Pass-1!", mapOf("Fly-Client-IP" to "203.0.113.77")).status)
        } finally {
            System.clearProperty("CLIENT_IP_HEADER")
        }
    }

    // ---------------------------------------------------------------- change password

    @Test
    fun `changing the password ends the other sessions, keeps this one and is audited without the password`() = testApplication {
        application { module() }
        createTestUser(nickname = "changer", rawPassword = "Old-Password-1!")
        val thisSession = tokenFrom(login("changer", "Old-Password-1!"))
        val otherSession = tokenFrom(login("changer", "Old-Password-1!"))
        assertEquals(HttpStatusCode.OK, get(otherSession, "/api/projects").status)

        val response = changePassword(thisSession, "Old-Password-1!", strongPassword)

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertEquals(HttpStatusCode.OK, get(thisSession, "/api/projects").status)
        assertEquals(HttpStatusCode.Unauthorized, get(otherSession, "/api/projects").status)
        assertEquals(HttpStatusCode.Unauthorized, login("changer", "Old-Password-1!").status)
        assertEquals(HttpStatusCode.OK, login("changer", strongPassword).status)

        val audit = auditRows("user.password_change")
        assertEquals(1, audit.size)
        assertFalse(audit[0].contains(strongPassword) || audit[0].contains("Old-Password-1!") || audit[0].contains("argon2"), "no secret in the audit row")
    }

    @Test
    fun `a wrong current password is refused and counted, and five of them lock the form`() = testApplication {
        application { module() }
        createTestUser(nickname = "changer", rawPassword = "Old-Password-1!")
        val token = tokenFrom(login("changer", "Old-Password-1!"))

        repeat(5) {
            val response = changePassword(token, "Not-The-Password-1!", strongPassword)
            assertEquals(HttpStatusCode.BadRequest, response.status)
            assertTrue(response.bodyAsText().contains("Stávající heslo není správné"))
        }

        val locked = changePassword(token, "Old-Password-1!", strongPassword)
        assertEquals(HttpStatusCode.TooManyRequests, locked.status)
        assertNotNull(locked.headers[HttpHeaders.RetryAfter])
        assertEquals(HttpStatusCode.OK, login("changer", "Old-Password-1!").status, "the password was not changed")
    }

    @Test
    fun `a new password that breaks the policy or equals the old one is refused`() = testApplication {
        application { module() }
        createTestUser(nickname = "changer", rawPassword = "Old-Password-1!")
        val token = tokenFrom(login("changer", "Old-Password-1!"))

        val weak = changePassword(token, "Old-Password-1!", "short")
        assertEquals(HttpStatusCode.BadRequest, weak.status)
        assertTrue(weak.bodyAsText().contains("alespoň 12 znaků"))

        assertEquals(HttpStatusCode.BadRequest, changePassword(token, "Old-Password-1!", "alllowercaseletters").status)
        assertEquals(HttpStatusCode.BadRequest, changePassword(token, "Old-Password-1!", "p".repeat(300)).status)

        val same = changePassword(token, "Old-Password-1!", "Old-Password-1!")
        assertEquals(HttpStatusCode.BadRequest, same.status)
        assertTrue(same.bodyAsText().contains("jiné"))

        assertEquals(HttpStatusCode.OK, login("changer", "Old-Password-1!").status, "the password was not changed")
        assertEquals(0, failuresRecorded(), "policy errors are not counted as failed attempts")
    }

    @Test
    fun `changing a password needs a login`() = testApplication {
        application { module() }

        val response = client.post("/api/auth/change-password") {
            contentType(ContentType.Application.Json)
            setBody("""{"currentPassword":"a","newPassword":"b"}""")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    // ---------------------------------------------------------------- temporary passwords

    @Test
    fun `a user with a temporary password can do nothing but change it`() = testApplication {
        application { module() }
        val user: SessionUser = createTestUser(nickname = "newcomer", rawPassword = "Temp-Password-1!")
        dsl.update(USERS).set(USERS.MUSTCHANGEPWD, true).where(USERS.ID.eq(user.id)).execute()
        val loginResponse = login("newcomer", "Temp-Password-1!")
        assertEquals(HttpStatusCode.OK, loginResponse.status)
        assertTrue(loginResponse.bodyAsText().contains("\"mustChangePwd\":true"))
        val token = tokenFrom(loginResponse)

        val blocked = get(token, "/api/projects")
        assertEquals(HttpStatusCode.Forbidden, blocked.status)
        assertEquals("PASSWORD_CHANGE_REQUIRED", Json.parseToJsonElement(blocked.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
        assertEquals(HttpStatusCode.Forbidden, get(token, "/api/users/options").status)

        assertEquals(HttpStatusCode.OK, changePassword(token, "Temp-Password-1!", strongPassword).status)

        assertEquals(HttpStatusCode.OK, get(token, "/api/projects").status, "the same session is free once the password is changed")
        assertFalse(dsl.select(USERS.MUSTCHANGEPWD).from(USERS).where(USERS.ID.eq(user.id)).fetchOne(USERS.MUSTCHANGEPWD)!!)
    }

    @Test
    fun `logout and health work while the password is temporary`() = testApplication {
        application { module() }
        val user = createTestUser(nickname = "newcomer", rawPassword = "Temp-Password-1!")
        dsl.update(USERS).set(USERS.MUSTCHANGEPWD, true).where(USERS.ID.eq(user.id)).execute()
        val token = tokenFrom(login("newcomer", "Temp-Password-1!"))

        assertEquals(HttpStatusCode.OK, client.get("/api/health").status)
        val logout = client.post("/api/auth/logout") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.OK, logout.status)
        assertEquals(HttpStatusCode.Unauthorized, get(token, "/api/projects").status)
    }

    @Test
    fun `an account made by an administrator starts with a temporary password`() = testApplication {
        application { module() }
        val admin = createTestUser(nickname = "the_admin", role = Role.BOSS, isAdmin = true)

        val created = client.post("/api/users") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(admin)}")
            setBody("""{"nickname":"fresh_user","displayName":"Fresh User","role":"WORKER"}""")
        }
        assertEquals(HttpStatusCode.Created, created.status, created.bodyAsText())
        assertEquals("no-store", created.headers[HttpHeaders.CacheControl])
        val password = Json.parseToJsonElement(created.bodyAsText()).jsonObject["initialPassword"]!!.jsonPrimitive.content

        val loginResponse = login("fresh_user", password)
        assertEquals(HttpStatusCode.OK, loginResponse.status)
        assertEquals(HttpStatusCode.Forbidden, get(tokenFrom(loginResponse), "/api/projects").status)
    }

    // ---------------------------------------------------------------- administrator reset

    @Test
    fun `an administrator can reset a password, which ends the user's sessions and demands a new one`() = testApplication {
        application { module() }
        val admin = createTestUser(nickname = "the_admin", role = Role.BOSS, isAdmin = true)
        val target = createTestUser(nickname = "forgetful", rawPassword = "Old-Password-1!")
        val targetSession = tokenFrom(login("forgetful", "Old-Password-1!"))
        assertEquals(HttpStatusCode.OK, get(targetSession, "/api/projects").status)

        val reset = client.post("/api/users/${target.id}/reset-password") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(admin)}")
        }

        assertEquals(HttpStatusCode.OK, reset.status, reset.bodyAsText())
        assertEquals("no-store", reset.headers[HttpHeaders.CacheControl])
        val newPassword = Json.parseToJsonElement(reset.bodyAsText()).jsonObject["initialPassword"]!!.jsonPrimitive.content
        assertTrue(newPassword.length >= 12)

        assertEquals(HttpStatusCode.Unauthorized, get(targetSession, "/api/projects").status, "the old session ended")
        assertEquals(HttpStatusCode.Unauthorized, login("forgetful", "Old-Password-1!").status)
        val fresh = login("forgetful", newPassword)
        assertEquals(HttpStatusCode.OK, fresh.status)
        assertEquals(HttpStatusCode.Forbidden, get(tokenFrom(fresh), "/api/projects").status, "the new password is temporary")

        val audit = auditRows("user.password_reset")
        assertEquals(1, audit.size)
        assertTrue(audit[0].contains(target.id.toString()))
        assertFalse(audit[0].contains(newPassword) || audit[0].contains("argon2"))
    }

    @Test
    fun `a reset lifts a login lockout of the account`() = testApplication {
        application { module() }
        val admin = createTestUser(nickname = "the_admin", role = Role.BOSS, isAdmin = true)
        val target = createTestUser(nickname = "locked_out", rawPassword = "Old-Password-1!")
        repeat(20) { login("locked_out", "Wrong-Pass-1!") }
        assertEquals(HttpStatusCode.TooManyRequests, login("locked_out", "Old-Password-1!").status)

        val reset = client.post("/api/users/${target.id}/reset-password") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(admin)}")
        }
        val newPassword = Json.parseToJsonElement(reset.bodyAsText()).jsonObject["initialPassword"]!!.jsonPrimitive.content

        // The address limit is separate (20 < 30), so the user can try again at once.
        assertEquals(HttpStatusCode.OK, login("locked_out", newPassword).status)
    }

    @Test
    fun `only an administrator can reset a password, and not their own`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "just_a_boss", role = Role.BOSS)
        val admin = createTestUser(nickname = "the_admin", role = Role.BOSS, isAdmin = true)
        val target = createTestUser(nickname = "someone")

        val byBoss = client.post("/api/users/${target.id}/reset-password") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}")
        }
        assertEquals(HttpStatusCode.Forbidden, byBoss.status)

        val adminToken = generateJwtToken(admin)
        val onSelf = client.post("/api/users/${admin.id}/reset-password") { header(HttpHeaders.Authorization, "Bearer $adminToken") }
        assertEquals(HttpStatusCode.BadRequest, onSelf.status)

        val unknown = client.post("/api/users/${java.util.UUID.randomUUID()}/reset-password") { header(HttpHeaders.Authorization, "Bearer $adminToken") }
        assertEquals(HttpStatusCode.NotFound, unknown.status)

        assertEquals(HttpStatusCode.OK, login("someone", "Password123!").status, "nothing was reset")
    }
}
