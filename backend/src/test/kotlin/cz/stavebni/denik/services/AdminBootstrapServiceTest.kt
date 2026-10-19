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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
        assertEquals(user("first.admin")!!.id.toString(), rows[0].get(AUDIT_LOG.ENTITY_ID), "the user's id, as for every other user row")
        assertNull(rows[0].get(AUDIT_LOG.PROJECT_ID), "a user belongs to no project")
        assertNull(rows[0].auditBeforeText())
        val after = kotlinx.serialization.json.Json.parseToJsonElement(rows[0].auditAfterText()!!).jsonObject
        assertEquals("true", after["isAdmin"]!!.jsonPrimitive.content, "the row records what was created")
        assertEquals("first.admin", after["nickname"]!!.jsonPrimitive.content)
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
    fun `the display name of the first administrator has the same limit as any other, 200 characters`() = runBlocking<Unit> {
        val tooLong = assertThrows<IllegalArgumentException> { AdminBootstrapService.createFirstAdmin("long.name", "Č".repeat(201)) }
        assertTrue(tooLong.message!!.contains("nejvýše 200 znaků"), tooLong.message)
        assertEquals(0, dsl.fetchCount(USERS), "nothing was created")

        AdminBootstrapService.createFirstAdmin("long.name", " " + "Č".repeat(200) + " ")

        assertEquals("Č".repeat(200), user("long.name")!!.displayname)
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
        repeat(rule.maxFailures) { RateLimiter.reserve(dsl, listOf(rule to UserService.loginKey("locked_admin"))) }
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

    // --- set-ckait ------------------------------------------------------------------------------

    private fun ckaitOf(nickname: String) = user(nickname)!!.ckaitnumber

    private fun updateRows() = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("user.update")).orderBy(AUDIT_LOG.ID.asc()).fetch()

    @Test
    fun `set-ckait gives an account its number, audited without an actor, with the number before and after`() = runBlocking<Unit> {
        val admin = createTestUser(nickname = "only_admin", role = Role.BOSS, isAdmin = true, ckaitNumber = null)
        generateJwtToken(admin) // an open session
        val passwordBefore = user("only_admin")!!.passwordhash

        val changed = AdminBootstrapService.setCkaitNumber(" only_admin ", " 0012345 ")

        assertTrue(changed)
        assertEquals("0012345", ckaitOf("only_admin"), "trimmed, like any ČKAIT number")
        val row = user("only_admin")!!
        assertEquals(passwordBefore, row.passwordhash, "the password is not touched")
        assertFalse(row.mustchangepwd!!)
        assertEquals(1, dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(admin.id).and(SESSIONS.REVOKEDAT.isNull)), "no session ends")
        val audit = updateRows().single()
        assertNull(audit.get(AUDIT_LOG.ACTOR_ID))
        assertEquals(admin.id.toString(), audit.get(AUDIT_LOG.ENTITY_ID), "the user's id, as for every other user row")
        val before = kotlinx.serialization.json.Json.parseToJsonElement(audit.auditBeforeText()!!).jsonObject
        val after = kotlinx.serialization.json.Json.parseToJsonElement(audit.auditAfterText()!!).jsonObject
        assertTrue(before["ckaitNumber"] is kotlinx.serialization.json.JsonNull, "no number before")
        assertEquals("0012345", after["ckaitNumber"]!!.jsonPrimitive.content)
        assertFalse(audit.formatJSON().contains("argon2"))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `set-ckait replaces a number, and writes nothing when the number is already that one`() = runBlocking<Unit> {
        createTestUser(nickname = "signer", role = Role.BOSS, ckaitNumber = "0000001")

        assertTrue(AdminBootstrapService.setCkaitNumber("signer", "0000002"))
        assertFalse(AdminBootstrapService.setCkaitNumber("signer", "0000002"))

        assertEquals("0000002", ckaitOf("signer"))
        assertEquals(1, updateRows().size, "an unchanged number leaves no row of before = after")
    }

    @Test
    fun `set-ckait also works for a deactivated account`() = runBlocking<Unit> {
        createTestUser(nickname = "on_leave", role = Role.BOSS, ckaitNumber = null)
        dsl.update(USERS).set(USERS.ISACTIVE, false).where(USERS.NICKNAME.eq("on_leave")).execute()

        assertTrue(AdminBootstrapService.setCkaitNumber("on_leave", "0000009"))

        assertEquals("0000009", ckaitOf("on_leave"))
    }

    @Test
    fun `set-ckait refuses an unknown or deleted user, a blank number and one over the limit, and changes nothing`() = runBlocking<Unit> {
        createTestUser(nickname = "kept", role = Role.BOSS, ckaitNumber = "0000001")
        createTestUser(nickname = "removed", role = Role.BOSS, ckaitNumber = "0000002")
        dsl.update(USERS).set(USERS.DELETEDAT, java.time.OffsetDateTime.now()).where(USERS.NICKNAME.eq("removed")).execute()

        assertThrows<IllegalStateException> { AdminBootstrapService.setCkaitNumber("nobody", "0000003") }
        assertThrows<IllegalStateException> { AdminBootstrapService.setCkaitNumber("removed", "0000003") }
        assertThrows<IllegalArgumentException> { AdminBootstrapService.setCkaitNumber("kept", "   ") }
        assertThrows<IllegalArgumentException> { AdminBootstrapService.setCkaitNumber("kept", "") }
        val tooLong = assertThrows<IllegalArgumentException> { AdminBootstrapService.setCkaitNumber("kept", "1".repeat(51)) }

        assertTrue(tooLong.message!!.contains("nejvýše 50 znaků"), tooLong.message)
        assertEquals("0000001", ckaitOf("kept"))
        assertEquals("0000002", user("removed")!!.ckaitnumber)
        assertEquals(0, updateRows().size, "refused: no row")
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
        for (args in listOf(
            emptyArray(), arrayOf("create-admin"), arrayOf("create-admin", "only-nick"), arrayOf("reset-password"), arrayOf("delete-everything"),
            arrayOf("set-ckait"), arrayOf("set-ckait", "only-nick"), arrayOf("set-ckait", "nick", "0012345", "extra"),
        )) {
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

    @Test
    fun `set-ckait through the command line`() {
        createTestUser(nickname = "only_admin", role = Role.BOSS, isAdmin = true, ckaitNumber = null)

        val run = cli("set-ckait", "only_admin", "0012345")

        assertEquals(0, run.code, run.err.toString())
        assertEquals("0012345", ckaitOf("only_admin"))
        assertTrue(run.out.any { it.contains("only_admin") && it.contains("0012345") }, run.out.toString())
        assertTrue(run.err.isEmpty())
        // Again with the same number: done, and it says that nothing changed.
        val again = cli("set-ckait", "only_admin", "0012345")
        assertEquals(0, again.code, again.err.toString())
        assertTrue(again.out.single().contains("unchanged", ignoreCase = true), again.out.toString())
    }

    @Test
    fun `a refused set-ckait exits 1 with the reason on stderr`() {
        createTestUser(nickname = "kept", role = Role.BOSS, ckaitNumber = "0000001")

        for (args in listOf(arrayOf("set-ckait", "nobody", "0000003"), arrayOf("set-ckait", "kept", "  "), arrayOf("set-ckait", "kept", "1".repeat(51)))) {
            val run = cli(*args)
            assertEquals(1, run.code, args.toList().toString())
            assertTrue(run.err.single().startsWith("Refused:"), run.err.toString())
            assertTrue(run.out.isEmpty())
        }
        assertEquals("0000001", ckaitOf("kept"))
    }

    @Test
    fun `set-ckait takes exactly a nickname and a number, and is not a read-only command`() {
        assertTrue(AdminCli.hasValidShape(listOf("set-ckait", "alice", "0012345")))
        assertFalse(AdminCli.hasValidShape(listOf("set-ckait", "alice")))
        assertFalse(AdminCli.hasValidShape(listOf("set-ckait")))
        assertFalse(AdminCli.hasValidShape(listOf("set-ckait", "alice", "0012345", "x")))
        assertFalse(AdminCli.readsOnly(listOf("set-ckait", "alice", "0012345")))
        assertTrue(AdminCli.USAGE.contains("set-ckait"))
    }

    @Test
    fun `set-ckait that cannot reach the database is exit code 3`() {
        val out = mutableListOf<String>()
        val err = mutableListOf<String>()

        val code = AdminCli.runGuarded(listOf("set-ckait", "alice", "0012345"), out::add, err::add) { error("no connection") }

        assertEquals(3, code)
        assertTrue(out.isEmpty())
    }
}
