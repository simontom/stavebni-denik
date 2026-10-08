package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.cli.AdminCli
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.SESSIONS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** Creating the first administrator and resetting a password from the command line. */
class AdminBootstrapServiceTest : BaseIntegrationTest() {

    private fun user(nickname: String) = dsl.selectFrom(USERS).where(USERS.NICKNAME.eq(nickname)).fetchOne()

    private fun auditJson(action: String): List<String> =
        dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).fetch().map { it.formatJSON() }

    // --- create-admin ---------------------------------------------------------------------------

    @Test
    fun `the first administrator is active, can log in with the generated password and must change it`() = runBlocking {
        val result = AdminBootstrapService.createFirstAdmin("  first.admin ", " Prvni Admin ")

        assertEquals("first.admin", result.nickname)
        val row = user("first.admin")!!
        assertTrue(row.isadmin!!)
        assertTrue(row.isactive!!)
        assertTrue(row.mustchangepwd!!)
        assertEquals("BOSS", row.role!!.name)
        assertEquals("Prvni Admin", row.displayname)
        assertTrue(PasswordService.verify(row.passwordhash!!, result.password))
        assertTrue(result.password.length >= 12)
    }

    @Test
    fun `creating the administrator is audited without an actor and without the password`() = runBlocking {
        val result = AdminBootstrapService.createFirstAdmin("first.admin", "Prvni Admin")

        val rows = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("user.bootstrap_admin")).fetch()
        assertEquals(1, rows.size)
        assertNull(rows[0].get(AUDIT_LOG.ACTOR_ID))
        assertEquals("first.admin", rows[0].get(AUDIT_LOG.ENTITY_ID))
        val json = auditJson("user.bootstrap_admin").single()
        assertFalse(json.contains(result.password) || json.contains("argon2"))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `an existing active administrator blocks it, a deactivated one does not`() = runBlocking {
        val existing = createTestUser(nickname = "existing_admin", role = Role.BOSS, isAdmin = true)

        val refused = assertThrows<IllegalStateException> { AdminBootstrapService.createFirstAdmin("second.admin", "Druhy Admin") }
        assertTrue(refused.message!!.contains("already exists"))
        assertNull(user("second.admin"))

        dsl.update(USERS).set(USERS.ISACTIVE, false).where(USERS.ID.eq(existing.id)).execute()
        AdminBootstrapService.createFirstAdmin("second.admin", "Druhy Admin")
        assertNotNull(user("second.admin"))
    }

    @Test
    fun `a name that is taken or malformed is refused`() = runBlocking {
        createTestUser(nickname = "taken_name", role = Role.WORKER)

        assertThrows<IllegalStateException> { AdminBootstrapService.createFirstAdmin("taken_name", "Nekdo") }
        assertThrows<IllegalArgumentException> { AdminBootstrapService.createFirstAdmin("a", "Nekdo") }
        assertThrows<IllegalArgumentException> { AdminBootstrapService.createFirstAdmin("has space", "Nekdo") }
        assertThrows<IllegalArgumentException> { AdminBootstrapService.createFirstAdmin("valid.name", "   ") }
        assertEquals(1, dsl.fetchCount(USERS))
    }

    @Test
    fun `two runs at once create exactly one administrator`() = runBlocking {
        val outcomes = coroutineScope {
            listOf("alice", "bob").map { nick ->
                async(Dispatchers.IO) { runCatching { AdminBootstrapService.createFirstAdmin(nick, "Admin $nick") } }
            }.awaitAll()
        }

        assertEquals(1, outcomes.count { it.isSuccess }, outcomes.toString())
        assertEquals(1, dsl.fetchCount(USERS, USERS.ISADMIN.eq(true)))
    }

    // --- reset-password -------------------------------------------------------------------------

    @Test
    fun `a reset gives a new temporary password and ends every session`() = runBlocking {
        val admin = createTestUser(nickname = "locked_admin", role = Role.BOSS, isAdmin = true, rawPassword = "Old-Password-1!")
        generateJwtToken(admin) // opens a session
        assertEquals(1, dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(admin.id).and(SESSIONS.REVOKEDAT.isNull)))

        val result = AdminBootstrapService.resetPassword(" locked_admin ")

        val row = user("locked_admin")!!
        assertTrue(PasswordService.verify(row.passwordhash!!, result.password))
        assertFalse(PasswordService.verify(row.passwordhash!!, "Old-Password-1!"))
        assertTrue(row.mustchangepwd!!)
        assertEquals(0, dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(admin.id).and(SESSIONS.REVOKEDAT.isNull)))
        val json = auditJson("user.password_reset").single()
        assertFalse(json.contains(result.password) || json.contains("argon2"))
    }

    @Test
    fun `a reset lifts a login lockout of the account`() = runBlocking {
        createTestUser(nickname = "locked_admin", role = Role.BOSS, isAdmin = true)
        val rule = RateLimiter.Rules.LOGIN_USER
        repeat(rule.maxFailures) { RateLimiter.recordFailure(dsl, rule, UserService.loginKey("locked_admin")) }
        assertNotNull(RateLimiter.retryAfter(dsl, rule, UserService.loginKey("locked_admin")), "the account is locked")

        AdminBootstrapService.resetPassword("locked_admin")

        assertNull(RateLimiter.retryAfter(dsl, rule, UserService.loginKey("locked_admin")))
    }

    @Test
    fun `a reset refuses unknown, deactivated and deleted accounts`() = runBlocking<Unit> {
        createTestUser(nickname = "gone_user", role = Role.WORKER)
        createTestUser(nickname = "removed_user", role = Role.WORKER)
        dsl.update(USERS).set(USERS.ISACTIVE, false).where(USERS.NICKNAME.eq("gone_user")).execute()
        dsl.update(USERS).set(USERS.DELETEDAT, java.time.OffsetDateTime.now()).where(USERS.NICKNAME.eq("removed_user")).execute()

        assertThrows<IllegalStateException> { AdminBootstrapService.resetPassword("nobody") }
        assertThrows<IllegalStateException> { AdminBootstrapService.resetPassword("gone_user") }
        assertThrows<IllegalStateException> { AdminBootstrapService.resetPassword("removed_user") }
    }

    // --- the command line -----------------------------------------------------------------------

    private class Run(val code: Int, val out: List<String>, val err: List<String>)

    private fun cli(vararg args: String): Run {
        val out = mutableListOf<String>()
        val err = mutableListOf<String>()
        val code = AdminCli.run(args.toList(), out::add, err::add)
        return Run(code, out, err)
    }

    @Test
    fun `create-admin prints the credentials once and exits 0`() {
        val run = cli("create-admin", "first.admin", "Prvni Admin")

        assertEquals(0, run.code, run.err.toString())
        assertTrue(run.out.any { it.startsWith("User:") && it.contains("first.admin") })
        val password = run.out.first { it.startsWith("Password:") }.removePrefix("Password:").trim()
        assertTrue(PasswordService.verify(user("first.admin")!!.passwordhash!!, password))
        assertTrue(run.err.isEmpty())
    }

    @Test
    fun `a refused command exits 1 with the reason on stderr and no password anywhere`() {
        createTestUser(nickname = "existing_admin", role = Role.BOSS, isAdmin = true)

        val run = cli("create-admin", "second.admin", "Druhy Admin")

        assertEquals(1, run.code)
        assertTrue(run.err.single().startsWith("Refused:"))
        assertTrue(run.out.isEmpty())
    }

    @Test
    fun `wrong usage exits 2 and prints the usage`() {
        for (args in listOf(emptyArray(), arrayOf("create-admin"), arrayOf("create-admin", "only-nick"), arrayOf("reset-password"), arrayOf("delete-everything"))) {
            val run = cli(*args)
            assertEquals(2, run.code, args.toList().toString())
            assertTrue(run.err.single().contains("Usage:"))
            assertTrue(run.out.isEmpty())
        }
    }

    @Test
    fun `reset-password through the command line`() {
        createTestUser(nickname = "forgetful", role = Role.WORKER, rawPassword = "Old-Password-1!")

        val run = cli("reset-password", "forgetful")

        assertEquals(0, run.code, run.err.toString())
        val password = run.out.first { it.startsWith("Password:") }.removePrefix("Password:").trim()
        assertTrue(PasswordService.verify(user("forgetful")!!.passwordhash!!, password))
        assertEquals(1, cli("reset-password", "nobody").code)
    }
}
