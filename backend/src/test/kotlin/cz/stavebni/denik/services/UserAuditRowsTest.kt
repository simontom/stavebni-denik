package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.util.UUID

/**
 * What the audit log keeps of a user (backlog A2): every change of a user is written in the same transaction as the
 * change, with the user's id and what the user was before and after, and nothing secret.
 */
class UserAuditRowsTest : BaseIntegrationTest() {

    private val strongPassword = "Nov3-Heslo-Pro-Test!"

    private fun admin() = createTestUser(nickname = "the_admin", role = Role.BOSS, isAdmin = true)

    private fun count() = dsl.fetchCount(AUDIT_LOG)

    private fun rows(action: String) = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.asc()).fetch()

    private fun obj(json: String?): JsonObject? = json?.let { Json.parseToJsonElement(it).jsonObject }

    private fun JsonObject.text(key: String): String? = get(key).let { if (it == null || it is JsonNull) null else it.jsonPrimitive.content }

    private fun JsonObject.flag(key: String): Boolean = getValue(key).jsonPrimitive.content.toBoolean()

    /** Runs [operation] and returns the one audit row it wrote; fails when it wrote none or more than one. */
    private fun oneRow(action: String, operation: () -> Unit): org.jooq.Record {
        val before = count()
        operation()
        assertEquals(before + 1, count(), "exactly one audit row for one change")
        return rows(action).last()
    }

    private fun asSession(user: UserDto) = SessionUser(
        id = UUID.fromString(user.id), nickname = user.nickname, displayName = user.displayName, role = Role.valueOf(user.role),
        isAdmin = user.isAdmin, mustChangePwd = user.mustChangePwd, sessionId = UUID.randomUUID(),
    )

    // ------------------------------------------------------------------------------ create

    @Test
    fun `user create records who the user is, with the id of the user and the actor`() = runBlocking<Unit> {
        val actor = admin()
        lateinit var created: CreateUserResponse

        val row = oneRow("user.create") {
            created = runBlocking {
                UserService.createUser(
                    actor,
                    CreateUserRequest(nickname = "novy.stavbyvedouci", displayName = " Ing. Jan Novák ", role = "BOSS", isAdmin = true, ckaitNumber = " 0054321 "),
                )
            }
        }

        assertEquals(created.user.id, row.get(AUDIT_LOG.ENTITY_ID), "the user's id, not the nickname")
        assertEquals("user", row.get(AUDIT_LOG.ENTITY_TYPE))
        assertEquals(actor.id.toString(), row.get(AUDIT_LOG.ACTOR_ID))
        assertNull(row.auditBeforeText(), "a created user has no before")
        val after = obj(row.auditAfterText())!!
        assertEquals(created.user.id, after.text("id"))
        assertEquals("novy.stavbyvedouci", after.text("nickname"))
        assertEquals("Ing. Jan Novák", after.text("displayName"))
        assertEquals("BOSS", after.text("role"))
        assertTrue(after.flag("isAdmin"))
        assertTrue(after.flag("isActive"))
        assertEquals("0054321", after.text("ckaitNumber"))
        assertTrue(after.flag("mustChangePwd"), "an account made by an administrator starts with a temporary password")
        assertNotNull(OffsetDateTime.parse(after.text("passwordExpiresAt")), "and the temporary password expires")
        assertNull(after.text("passwordChangedAt"))
        assertNull(after.text("deletedAt"))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a user without a ckait number is recorded as one without`() = runBlocking<Unit> {
        val row = oneRow("user.create") {
            runBlocking { UserService.createUser(admin(), CreateUserRequest(nickname = "plain.worker", displayName = "Pavel Dělník")) }
        }

        val after = obj(row.auditAfterText())!!
        assertEquals("WORKER", after.text("role"))
        assertFalse(after.flag("isAdmin"))
        assertTrue(after.containsKey("ckaitNumber"), "the field is there, null")
        assertNull(after.text("ckaitNumber"))
    }

    // ------------------------------------------------------------------------------ the other changes

    @Test
    fun `editing a user is one row with the name, role, flag and ckait number before and after`() = runBlocking<Unit> {
        val actor = admin()
        val target = createTestUser(nickname = "edited", displayName = "Stará Jména", role = Role.WORKER, ckaitNumber = null)

        val row = oneRow("user.update") {
            runBlocking {
                UserService.updateUser(actor, target.id, UpdateUserRequest(displayName = "Nová Jména", role = "BOSS", isAdmin = true, ckaitNumber = "0011223"))
            }
        }

        assertEquals(target.id.toString(), row.get(AUDIT_LOG.ENTITY_ID))
        val before = obj(row.auditBeforeText())!!
        val after = obj(row.auditAfterText())!!
        assertEquals("Stará Jména" to "Nová Jména", before.text("displayName") to after.text("displayName"))
        assertEquals("WORKER" to "BOSS", before.text("role") to after.text("role"))
        assertEquals(false to true, before.flag("isAdmin") to after.flag("isAdmin"))
        assertNull(before.text("ckaitNumber"))
        assertEquals("0011223", after.text("ckaitNumber"))
    }

    @Test
    fun `deactivating and activating are one row each, with the state before and after`() = runBlocking<Unit> {
        val actor = admin()
        val target = createTestUser(nickname = "toggled", role = Role.WORKER)

        val off = oneRow("user.deactivate") { runBlocking { UserService.setActive(actor, target.id, active = false) } }
        val on = oneRow("user.activate") { runBlocking { UserService.setActive(actor, target.id, active = true) } }

        assertEquals(target.id.toString(), off.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(true to false, obj(off.auditBeforeText())!!.flag("isActive") to obj(off.auditAfterText())!!.flag("isActive"))
        assertEquals(target.id.toString(), on.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(false to true, obj(on.auditBeforeText())!!.flag("isActive") to obj(on.auditAfterText())!!.flag("isActive"))
        assertEquals(actor.id.toString(), off.get(AUDIT_LOG.ACTOR_ID))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `deleting a user is one row that shows the user as deleted afterwards`() = runBlocking<Unit> {
        val actor = admin()
        val target = createTestUser(nickname = "to.delete", displayName = "Marie Smazaná", role = Role.WORKER)

        val row = oneRow("user.delete") { runBlocking { UserService.deleteUser(actor, target.id) } }

        assertEquals(target.id.toString(), row.get(AUDIT_LOG.ENTITY_ID))
        val before = obj(row.auditBeforeText())!!
        val after = obj(row.auditAfterText())!!
        assertNull(before.text("deletedAt"))
        assertTrue(before.flag("isActive"))
        assertNotNull(OffsetDateTime.parse(after.text("deletedAt")))
        assertFalse(after.flag("isActive"))
        assertEquals("Marie Smazaná", after.text("displayName"), "who the user was stays readable")
        assertEquals("to.delete", after.text("nickname"))
    }

    @Test
    fun `an own password change is one row that shows the password as chosen, with no secret in it`() = runBlocking<Unit> {
        val user = createTestUser(nickname = "changer", role = Role.WORKER, rawPassword = "Old-Password-1!")
        dsl.update(USERS).set(USERS.MUSTCHANGEPWD, true).set(USERS.PASSWORDEXPIRESAT, OffsetDateTime.now().plusDays(3)).where(USERS.ID.eq(user.id)).execute()

        val row = oneRow("user.password_change") {
            runBlocking { UserService.changeOwnPassword(user, ChangePasswordRequest("Old-Password-1!", strongPassword)) }
        }

        assertEquals(user.id.toString(), row.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(user.id.toString(), row.get(AUDIT_LOG.ACTOR_ID))
        val before = obj(row.auditBeforeText())!!
        val after = obj(row.auditAfterText())!!
        assertTrue(before.flag("mustChangePwd"))
        assertNotNull(before.text("passwordExpiresAt"))
        assertNull(before.text("passwordChangedAt"))
        assertFalse(after.flag("mustChangePwd"))
        assertNull(after.text("passwordExpiresAt"), "a chosen password does not expire")
        assertNotNull(OffsetDateTime.parse(after.text("passwordChangedAt")), "and it says when the user chose it")
        assertFalse(row.formatJSON().contains(strongPassword) || row.formatJSON().contains("Old-Password-1!") || row.formatJSON().contains("argon2"))
    }

    @Test
    fun `an administrator reset is one row that shows a temporary password with an expiry`() = runBlocking<Unit> {
        val actor = admin()
        val target = createTestUser(nickname = "forgetful", role = Role.WORKER)
        dsl.update(USERS).set(USERS.PASSWORDCHANGEDAT, OffsetDateTime.now().minusDays(30)).where(USERS.ID.eq(target.id)).execute()
        lateinit var reset: ResetPasswordResponse

        val row = oneRow("user.password_reset") { reset = runBlocking { UserService.resetPassword(actor, target.id) } }

        assertEquals(target.id.toString(), row.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(actor.id.toString(), row.get(AUDIT_LOG.ACTOR_ID))
        val before = obj(row.auditBeforeText())!!
        val after = obj(row.auditAfterText())!!
        assertFalse(before.flag("mustChangePwd"))
        assertNotNull(before.text("passwordChangedAt"))
        assertTrue(after.flag("mustChangePwd"))
        assertNotNull(OffsetDateTime.parse(after.text("passwordExpiresAt")))
        assertNull(after.text("passwordChangedAt"), "a temporary password is not one the user chose")
        assertFalse(row.formatJSON().contains(reset.initialPassword) || row.formatJSON().contains("argon2"))
    }

    @Test
    fun `a refused change leaves no audit row`() = runBlocking<Unit> {
        val adminA = createTestUser(nickname = "admin_a", role = Role.BOSS, isAdmin = true)
        val adminB = createTestUser(nickname = "admin_b", role = Role.BOSS, isAdmin = true)
        UserService.setActive(adminA, adminB.id, active = false)
        val before = count()

        // adminB's request started while it still was an administrator, so only the guard itself refuses these: adminA is the last one.
        assertThrows<IllegalStateException> { UserService.setActive(adminB, adminA.id, active = false) }
        assertThrows<IllegalStateException> { UserService.updateUser(adminB, adminA.id, UpdateUserRequest(isAdmin = false)) }
        assertThrows<IllegalStateException> { UserService.deleteUser(adminB, adminA.id) }
        assertThrows<IllegalArgumentException> { UserService.resetPassword(adminA, adminA.id) }
        assertThrows<NotFoundException> { UserService.setActive(adminA, UUID.randomUUID(), active = true) }
        assertThrows<NotFoundException> { UserService.deleteUser(adminA, UUID.randomUUID()) }
        assertThrows<NotFoundException> { UserService.resetPassword(adminA, UUID.randomUUID()) }

        assertEquals(before, count())
    }

    // ------------------------------------------------------------------------------ the operator commands

    @Test
    fun `the command line commands write rows with the user's id, no actor, and the state before and after`() = runBlocking<Unit> {
        val created = AdminBootstrapService.createFirstAdmin("first.admin", "Prvni Admin")
        val id = dsl.selectFrom(USERS).where(USERS.NICKNAME.eq("first.admin")).fetchOne()!!.id.toString()

        val createRow = rows("user.bootstrap_admin").single()
        assertEquals(id, createRow.get(AUDIT_LOG.ENTITY_ID), "the user's id, not the nickname")
        assertNull(createRow.get(AUDIT_LOG.ACTOR_ID))
        assertNull(createRow.auditBeforeText())
        val after = obj(createRow.auditAfterText())!!
        assertEquals("first.admin", after.text("nickname"))
        assertEquals("BOSS", after.text("role"))
        assertTrue(after.flag("isAdmin"))
        assertTrue(after.flag("mustChangePwd"))
        assertNotNull(after.text("passwordExpiresAt"))

        val resetRow = oneRow("user.password_reset") { runBlocking { AdminBootstrapService.resetPassword("first.admin") } }
        assertEquals(id, resetRow.get(AUDIT_LOG.ENTITY_ID))
        assertNull(resetRow.get(AUDIT_LOG.ACTOR_ID))
        assertEquals("first.admin", obj(resetRow.auditBeforeText())!!.text("nickname"))
        assertNotNull(obj(resetRow.auditAfterText())!!.text("passwordExpiresAt"))

        val all = dsl.selectFrom(AUDIT_LOG).fetch().joinToString { it.formatJSON() }
        assertFalse(all.contains(created.password) || all.contains("argon2"))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    // ------------------------------------------------------------------------------ no secrets

    @Test
    fun `the snapshot of a user has no field that could hold a password, a hash or a token`() {
        val names = UserSnapshot.serializer().descriptor.elementNames.toList()

        assertTrue(names.containsAll(listOf("id", "nickname", "displayName", "role", "isAdmin", "isActive", "ckaitNumber")), names.toString())
        for (name in names.map { it.lowercase() }) {
            assertFalse(name.contains("hash") || name.contains("token") || name.contains("secret") || name == "password", "field '$name' must not be in an audit snapshot")
        }
    }

    @Test
    fun `no audit row of any user operation contains a password, a hash or a token`() = runBlocking<Unit> {
        val actor = admin()
        val created = UserService.createUser(actor, CreateUserRequest(nickname = "everything", displayName = "Vše Vykonané", role = "BOSS", ckaitNumber = "0000001"))
        val user = asSession(created.user)
        UserService.changeOwnPassword(user, ChangePasswordRequest(created.initialPassword, strongPassword))
        val reset = UserService.resetPassword(actor, user.id)
        UserService.updateUser(actor, user.id, UpdateUserRequest(displayName = "Vše Vykonané 2"))
        UserService.setActive(actor, user.id, active = false)
        UserService.setActive(actor, user.id, active = true)
        dsl.update(USERS).set(USERS.ISADMIN, false).where(USERS.ID.eq(actor.id)).execute() // no active administrator left: the operator may create one
        val bootstrap = AdminBootstrapService.createFirstAdmin("cli.admin", "Provozní Správce")
        val cliReset = AdminBootstrapService.resetPassword("cli.admin")
        UserService.deleteUser(actor, user.id) // the actor's session still says administrator

        val secrets = listOf(created.initialPassword, strongPassword, reset.initialPassword, bootstrap.password, cliReset.password) +
            dsl.select(USERS.PASSWORDHASH).from(USERS).fetch(USERS.PASSWORDHASH).filterNotNull()
        val stored = dsl.selectFrom(AUDIT_LOG).fetch()
        assertTrue(stored.size >= 9, "the operations above wrote their rows: ${stored.size}")
        for (row in stored) {
            val json = row.formatJSON()
            for (secret in secrets) assertFalse(json.contains(secret), "audit row ${row.get(AUDIT_LOG.ID)} (${row.get(AUDIT_LOG.ACTION)}) holds a secret")
            assertFalse(json.contains("argon2", ignoreCase = true), "audit row ${row.get(AUDIT_LOG.ID)} holds a hash")
        }
        val allowed = UserSnapshot.serializer().descriptor.elementNames.toSet()
        for (row in stored.filter { it.get(AUDIT_LOG.ENTITY_TYPE) == "user" }) {
            for (snapshot in listOf(row.auditBeforeText(), row.auditAfterText())) {
                val keys = obj(snapshot)?.keys ?: continue
                assertEquals(allowed, keys, "the stored JSON of row ${row.get(AUDIT_LOG.ID)} has exactly the fields of a UserSnapshot")
            }
        }
    }

    // ------------------------------------------------------------------------------ the chain

    @Test
    fun `the chain verifies after a mix of user and report operations`() = runBlocking<Unit> {
        val actor = admin()
        val boss = createTestUser(nickname = "site.boss", role = Role.BOSS)
        val worker = UserService.createUser(actor, CreateUserRequest(nickname = "site.worker", displayName = "Karel Dělník")).user
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Mix", address = "Adresa", cadastralArea = "Území", parcelNumbers = "1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        addMember(projectId, asSession(worker), Role.WORKER)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž")
        UserService.updateUser(actor, UUID.fromString(worker.id), UpdateUserRequest(displayName = "Karel Dělník ml."))
        lockUnchecked(boss, UUID.fromString(report.id))
        UserService.setActive(actor, UUID.fromString(worker.id), active = false)
        UserService.setActive(actor, UUID.fromString(worker.id), active = true)
        UserService.resetPassword(actor, UUID.fromString(worker.id))
        UserService.changeOwnPassword(boss, ChangePasswordRequest("Password123!", strongPassword))
        UserService.deleteUser(actor, UUID.fromString(worker.id))

        val result = AuditService.verifyChain(dsl)

        assertTrue(result.ok, result.reason)
        val actions = dsl.select(AUDIT_LOG.ACTION).from(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch(AUDIT_LOG.ACTION)
        assertEquals(result.totalRows, actions.size.toLong())
        assertEquals(
            listOf(
                "user.create", "project.create", "project.member.add", "report.create", "user.update", "report.lock",
                "user.deactivate", "user.activate", "user.password_reset", "user.password_change", "user.delete",
            ),
            actions,
            "one row for each operation, in the order they were made (a project also records its first manager)",
        )
    }

    // ------------------------------------------------------------------------------ one transaction

    @Test
    fun `when the audit row cannot be written the change is not made either`() = runBlocking<Unit> {
        val actor = admin()
        val target = createTestUser(nickname = "keeps.name", displayName = "Původní", role = Role.WORKER)
        val before = count()
        val users = dsl.fetchCount(USERS)

        dsl.withFailingTrigger("audit_log", "INSERT") {
            runBlocking { assertInjectedFailure { UserService.createUser(actor, CreateUserRequest(nickname = "never.created", displayName = "Nikdy")) } }
            runBlocking { assertInjectedFailure { UserService.updateUser(actor, target.id, UpdateUserRequest(displayName = "Změněné")) } }
            runBlocking { assertInjectedFailure { UserService.setActive(actor, target.id, active = false) } }
            runBlocking { assertInjectedFailure { UserService.resetPassword(actor, target.id) } }
            runBlocking { assertInjectedFailure { UserService.deleteUser(actor, target.id) } }
        }

        assertEquals(users, dsl.fetchCount(USERS), "no user was created")
        val stored = dsl.selectFrom(USERS).where(USERS.ID.eq(target.id)).fetchOne()!!
        assertEquals("Původní", stored.displayname)
        assertTrue(stored.isactive!!)
        assertNull(stored.deletedat)
        assertFalse(stored.mustchangepwd!!, "the reset did not happen")
        assertEquals(before, count())
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `when the change fails after it was made, no audit row is left and nothing is changed`() = runBlocking<Unit> {
        val actor = admin()
        val target = createTestUser(nickname = "has.session", role = Role.WORKER)
        generateJwtToken(target) // an open session: deactivating has to end it
        val before = count()

        dsl.withFailingTrigger("sessions", "UPDATE") {
            runBlocking { assertInjectedFailure { UserService.setActive(actor, target.id, active = false) } }
            runBlocking { assertInjectedFailure { UserService.deleteUser(actor, target.id) } }
            runBlocking { assertInjectedFailure { UserService.resetPassword(actor, target.id) } }
        }

        val stored = dsl.selectFrom(USERS).where(USERS.ID.eq(target.id)).fetchOne()!!
        assertTrue(stored.isactive!!, "still active: the deactivation was rolled back with its session revocation")
        assertNull(stored.deletedat)
        assertEquals(before, count(), "and no row says otherwise")
    }
}
