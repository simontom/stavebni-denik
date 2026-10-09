package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS
import cz.stavebni.denik.jooq.tables.references.SESSIONS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.ChangePasswordRequest
import cz.stavebni.denik.services.CreateUserRequest
import cz.stavebni.denik.services.PasswordService
import cz.stavebni.denik.services.SessionService
import cz.stavebni.denik.services.UserService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.Duration
import java.time.OffsetDateTime
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * What happens when several credential requests overlap, and how long a temporary password lives.
 * (The single-request behaviour is in [CredentialsRoutesTest].)
 */
class CredentialRaceRoutesTest : BaseIntegrationTest() {

    private suspend fun ApplicationTestBuilder.login(nickname: String, password: String, headers: Map<String, String> = emptyMap()): HttpResponse =
        client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            headers.forEach { (k, v) -> header(k, v) }
            setBody("""{"nickname":${JsonPrimitive(nickname)},"password":${JsonPrimitive(password)}}""")
        }

    private fun admin(): SessionUser = createTestUser(nickname = "the_admin", role = Role.BOSS, isAdmin = true)

    // ------------------------------------------------------------------ the limit holds under parallel attempts

    @Test
    fun `parallel wrong passwords for one name get exactly the twenty the limit allows`() = testApplication {
        application { module() }
        createTestUser(nickname = "victim", rawPassword = "Correct-Pass-1!")

        val statuses = coroutineScope {
            (1..45).map { async(Dispatchers.IO) { login("victim", "Wrong-Pass-1!").status } }.awaitAll()
        }

        assertEquals(20, statuses.count { it == HttpStatusCode.Unauthorized }, "attempts that were let through to the password check")
        assertEquals(25, statuses.count { it == HttpStatusCode.TooManyRequests }, "attempts refused")
        assertEquals(20, dsl.fetchCount(RATE_LIMIT_ATTEMPTS, RATE_LIMIT_ATTEMPTS.BUCKET.eq("login:user")))
    }

    @Test
    fun `behind a proxy header an IPv6 client cannot get a fresh limit by changing the last 64 bits`() = testApplication {
        application { module() }
        createTestUser(nickname = "real_user", rawPassword = "Correct-Pass-1!")
        System.setProperty("CLIENT_IP_HEADER", "Fly-Client-IP")
        try {
            // 30 failures, each from a different address of the same /64 and against a different name.
            repeat(30) { i -> login("guess_$i", "Wrong-Pass-1!", mapOf("Fly-Client-IP" to "2001:db8:aa:bb:${i + 1}::${i + 7}")) }

            val sameNetwork = login("real_user", "Correct-Pass-1!", mapOf("Fly-Client-IP" to "2001:db8:aa:bb:ffff:ffff:ffff:ffff"))
            assertEquals(HttpStatusCode.TooManyRequests, sameNetwork.status)
            val otherNetwork = login("real_user", "Correct-Pass-1!", mapOf("Fly-Client-IP" to "2001:db8:aa:bc::1"))
            assertEquals(HttpStatusCode.OK, otherNetwork.status)
        } finally {
            System.clearProperty("CLIENT_IP_HEADER")
        }
    }

    @Test
    fun `a successful login gives its attempt back`() = testApplication {
        application { module() }
        createTestUser(nickname = "real_user", rawPassword = "Correct-Pass-1!")

        repeat(3) { assertEquals(HttpStatusCode.OK, login("real_user", "Correct-Pass-1!").status) }

        assertEquals(0, dsl.fetchCount(RATE_LIMIT_ATTEMPTS), "successes leave nothing on record")
    }

    // ------------------------------------------------------------------ a login that overlaps a password reset

    @Test
    fun `a session is not opened for a password that was reset after it was checked`() = runBlocking<Unit> {
        val boss = admin()
        val target = createTestUser(nickname = "target", rawPassword = "Old-Password-1!")
        val checkedHash = dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(target.id)).fetchOne(USERS.PASSWORDHASH)!!
        assertTrue(PasswordService.verify(checkedHash, "Old-Password-1!"))

        // The login has checked the password; before it opens the session an administrator resets it.
        UserService.resetPassword(boss, target.id)
        val opened = SessionService.openAfterPasswordCheck(dsl, target.id, checkedHash)

        assertSame(SessionService.Opened.CredentialsChanged, opened)
        assertEquals(0, dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(target.id)), "no session behind a password nobody has any more")
    }

    @Test
    fun `a login that overlaps a reset in progress waits for it and then gets no session`() {
        val boss = admin()
        val target = createTestUser(nickname = "target", rawPassword = "Old-Password-1!")
        val checkedHash = dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(target.id)).fetchOne(USERS.PASSWORDHASH)!!

        val resetHoldsTheRow = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            // A reset that has changed the password but not committed yet (it ends the sessions in the same transaction).
            val reset = pool.submit {
                dsl.transaction { cfg ->
                    val tx = org.jooq.impl.DSL.using(cfg)
                    tx.update(USERS).set(USERS.PASSWORDHASH, PasswordService.hash("Temp-Password-1!")).where(USERS.ID.eq(target.id)).execute()
                    resetHoldsTheRow.countDown()
                    Thread.sleep(700)
                    SessionService.revokeAllForUser(tx, target.id)
                }
            }
            assertTrue(resetHoldsTheRow.await(10, TimeUnit.SECONDS))

            val started = System.nanoTime()
            val opened = SessionService.openAfterPasswordCheck(dsl, target.id, checkedHash)
            val waitedMs = Duration.ofNanos(System.nanoTime() - started).toMillis()

            reset.get(10, TimeUnit.SECONDS)
            assertTrue(waitedMs >= 300, "the login had to wait for the reset's row lock, waited ${waitedMs} ms")
            assertSame(SessionService.Opened.CredentialsChanged, opened)
            assertEquals(0, dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(target.id)))
            assertNotNull(boss)
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun `an unchanged password opens a session`() {
        val target = createTestUser(nickname = "target", rawPassword = "Old-Password-1!")
        val hash = dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(target.id)).fetchOne(USERS.PASSWORDHASH)!!

        val opened = SessionService.openAfterPasswordCheck(dsl, target.id, hash)

        assertTrue(opened is SessionService.Opened.Session)
        assertEquals(1, dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(target.id)))
    }

    // ------------------------------------------------------------------ two password changes at once

    @Test
    fun `only one of several simultaneous password changes made with the same current password wins`() = runBlocking<Unit> {
        val user = createTestUser(nickname = "changer", rawPassword = "Old-Password-1!")
        val candidates = (1..4).map { "Nov3-Heslo-Cislo-$it!" }

        val outcomes = candidates.map { candidate ->
            async(Dispatchers.IO) {
                runCatching { UserService.changeOwnPassword(user, ChangePasswordRequest("Old-Password-1!", candidate)) }
            }
        }.awaitAll()

        assertEquals(1, outcomes.count { it.isSuccess }, outcomes.map { it.exceptionOrNull()?.message }.toString())
        val hash = dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(user.id)).fetchOne(USERS.PASSWORDHASH)!!
        val winner = candidates[outcomes.indexOfFirst { it.isSuccess }]
        assertTrue(PasswordService.verify(hash, winner), "the stored password is the winner's")
        assertEquals(3, outcomes.count { it.isFailure })
        // A refused change is told apart from a limit: it is a plain refusal.
        outcomes.filter { it.isFailure }.forEach {
            val e = it.exceptionOrNull()!!
            assertTrue(e is IllegalArgumentException || e is IllegalStateException, e.toString())
        }
    }

    @Test
    fun `a change made on the strength of a password that was reset meanwhile does not overwrite the reset`() = runBlocking<Unit> {
        val boss = admin()
        val user = createTestUser(nickname = "changer", rawPassword = "Old-Password-1!")

        // Let the change run to the point where it has checked the old password, then reset it underneath.
        val oldHash = dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(user.id)).fetchOne(USERS.PASSWORDHASH)!!
        val reset = UserService.resetPassword(boss, user.id)
        val newHash = dsl.select(USERS.PASSWORDHASH).from(USERS).where(USERS.ID.eq(user.id)).fetchOne(USERS.PASSWORDHASH)!!
        assertNotEquals(oldHash, newHash)

        // The change with the old password is refused now (the check fails), and the temporary password stays.
        val result = runCatching { UserService.changeOwnPassword(user, ChangePasswordRequest("Old-Password-1!", "Nov3-Heslo-Cislo-9!")) }
        assertTrue(result.isFailure)
        val after = dsl.select(USERS.PASSWORDHASH, USERS.MUSTCHANGEPWD).from(USERS).where(USERS.ID.eq(user.id)).fetchOne()!!
        assertEquals(newHash, after.get(USERS.PASSWORDHASH))
        assertTrue(after.get(USERS.MUSTCHANGEPWD)!!, "still has to change the temporary password")
        assertTrue(PasswordService.verify(newHash, reset.initialPassword))
    }

    // ------------------------------------------------------------------ temporary passwords expire

    private fun expiresAt(nickname: String): OffsetDateTime? =
        dsl.select(USERS.PASSWORDEXPIRESAT).from(USERS).where(USERS.NICKNAME.eq(nickname)).fetchOne(USERS.PASSWORDEXPIRESAT)

    @Test
    fun `a generated password works for a week, a password the user chose does not expire`() = runBlocking<Unit> {
        val boss = admin()
        val created = UserService.createUser(boss, CreateUserRequest(nickname = "newcomer", displayName = "New Comer", role = "BOSS"))

        val expiry = expiresAt("newcomer")
        assertNotNull(expiry, "a generated password has an expiry")
        val remaining = Duration.between(OffsetDateTime.now(), expiry)
        assertTrue(remaining > Duration.ofDays(6) && remaining <= Duration.ofDays(7), "about a week: $remaining")

        val user = UserService.findUserByNickname(dsl, "newcomer")!!
        UserService.changeOwnPassword(user, ChangePasswordRequest(created.initialPassword, "Nov3-Heslo-Cislo-1!"))
        assertNull(expiresAt("newcomer"), "a chosen password does not expire")

        UserService.resetPassword(boss, user.id)
        assertNotNull(expiresAt("newcomer"), "a reset makes a new temporary password with a new expiry")
    }

    @Test
    fun `an expired temporary password is refused with its own message and no session`() = testApplication {
        application { module() }
        val boss = admin()
        val created = UserService.createUser(boss, CreateUserRequest(nickname = "slowpoke", displayName = "Slow Poke", role = "BOSS"))
        dsl.update(USERS).set(USERS.PASSWORDEXPIRESAT, OffsetDateTime.now().minusMinutes(1)).where(USERS.NICKNAME.eq("slowpoke")).execute()

        val expired = login("slowpoke", created.initialPassword)

        assertEquals(HttpStatusCode.Unauthorized, expired.status)
        val body = Json.parseToJsonElement(expired.bodyAsText()).jsonObject
        assertEquals("PASSWORD_EXPIRED", body["code"]!!.jsonPrimitive.content)
        assertNull(expired.headers[HttpHeaders.SetCookie], "no cookie")
        assertEquals(0, dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(UserService.findUserByNickname(dsl, "slowpoke")!!.id)))

        // Someone who does not have the password learns nothing from it: a wrong password gets the usual answer.
        val wrong = login("slowpoke", "Wrong-Pass-1!")
        assertEquals(HttpStatusCode.Unauthorized, wrong.status)
        assertFalse(wrong.bodyAsText().contains("PASSWORD_EXPIRED"), wrong.bodyAsText())
    }

    @Test
    fun `an administrator can issue a new temporary password after the first one expired`() = testApplication {
        application { module() }
        val boss = admin()
        val created = UserService.createUser(boss, CreateUserRequest(nickname = "slowpoke", displayName = "Slow Poke", role = "BOSS"))
        dsl.update(USERS).set(USERS.PASSWORDEXPIRESAT, OffsetDateTime.now().minusDays(1)).where(USERS.NICKNAME.eq("slowpoke")).execute()
        assertEquals(HttpStatusCode.Unauthorized, login("slowpoke", created.initialPassword).status)

        val reset = UserService.resetPassword(boss, UserService.findUserByNickname(dsl, "slowpoke")!!.id)

        val response = login("slowpoke", reset.initialPassword)
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertTrue(Json.parseToJsonElement(response.bodyAsText()).jsonObject["user"]!!.jsonObject["mustChangePwd"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `a password nobody set a temporary flag on never expires`() = testApplication {
        application { module() }
        createTestUser(nickname = "old_timer", rawPassword = "Correct-Pass-1!")

        assertNull(expiresAt("old_timer"))
        assertEquals(HttpStatusCode.OK, login("old_timer", "Correct-Pass-1!").status)
    }
}
