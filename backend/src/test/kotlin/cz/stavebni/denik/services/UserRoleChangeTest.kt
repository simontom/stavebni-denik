package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.SESSIONS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** Who may change whose role, and what a change does to sessions and to the audit log. */
class UserRoleChangeTest : BaseIntegrationTest() {

    private fun openSessions(userId: java.util.UUID) = dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(userId).and(SESSIONS.REVOKEDAT.isNull))

    @Test
    fun `an administrator cannot change their own role`() = runBlocking<Unit> {
        val admin = createTestUser(role = Role.WORKER, isAdmin = true)

        val refused = assertThrows<IllegalArgumentException> { UserService.updateUser(admin, admin.id, UpdateUserRequest(role = "BOSS")) }

        assertTrue(refused.message!!.contains("vlastní roli"), refused.message)
        assertEquals("WORKER", dsl.selectFrom(USERS).where(USERS.ID.eq(admin.id)).fetchOne()!!.role!!.name)
    }

    @Test
    fun `an administrator can still edit their own name, and that does not log them out`() = runBlocking<Unit> {
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        generateJwtToken(admin) // opens a session
        assertEquals(1, openSessions(admin.id))

        // The admin screen sends the role along with the name; an unchanged role is not a change.
        val updated = UserService.updateUser(admin, admin.id, UpdateUserRequest(displayName = "Nové Jméno", role = "BOSS"))

        assertEquals("Nové Jméno", updated.displayName)
        assertEquals(1, openSessions(admin.id), "rights did not change, so the session stays")
    }

    @Test
    fun `changing someone else's role ends their sessions and is audited with before and after`() = runBlocking<Unit> {
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val worker = createTestUser(role = Role.WORKER)
        generateJwtToken(worker)

        UserService.updateUser(admin, worker.id, UpdateUserRequest(role = "BOSS"))

        assertEquals(0, openSessions(worker.id), "the new rights apply at once")
        val row = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("user.update")).fetchOne()!!
        assertEquals(worker.id.toString(), row.get(AUDIT_LOG.ENTITY_ID))
        val before = Json.parseToJsonElement(row.get(AUDIT_LOG.BEFORE)!!.data()).jsonObject
        val after = Json.parseToJsonElement(row.get(AUDIT_LOG.AFTER)!!.data()).jsonObject
        assertEquals("WORKER", before["role"]!!.jsonPrimitive.content)
        assertEquals("BOSS", after["role"]!!.jsonPrimitive.content)
        assertFalse(row.formatJSON().contains("argon2"), "no password hash in the audit row")
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `granting the administrator flag is audited`() = runBlocking<Unit> {
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val other = createTestUser(role = Role.BOSS)

        UserService.updateUser(admin, other.id, UpdateUserRequest(isAdmin = true))

        val row = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("user.update")).fetchOne()!!
        assertEquals("false", Json.parseToJsonElement(row.get(AUDIT_LOG.BEFORE)!!.data()).jsonObject["isAdmin"]!!.jsonPrimitive.content)
        assertEquals("true", Json.parseToJsonElement(row.get(AUDIT_LOG.AFTER)!!.data()).jsonObject["isAdmin"]!!.jsonPrimitive.content)
    }
}
