package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** "alice" and "Alice" are the same account name: look-alikes in a legal record are refused. */
class NicknameCaseTest : BaseIntegrationTest() {

    @Test
    fun `creating a name that differs only in case is refused`() = runBlocking<Unit> {
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        UserService.createUser(admin, CreateUserRequest(nickname = "alice", displayName = "Alice"))

        val refused = assertThrows<IllegalStateException> {
            UserService.createUser(admin, CreateUserRequest(nickname = "Alice", displayName = "Another Alice"))
        }

        assertTrue(refused.message!!.contains("existuje"), refused.message)
        assertEquals(1, dsl.fetchCount(USERS, USERS.NICKNAME.likeIgnoreCase("alice")))
    }

    @Test
    fun `the database refuses it too`() {
        createTestUser(nickname = "bob.builder")

        assertThrows<DataAccessException> { createTestUser(nickname = "Bob.Builder") }
    }

    @Test
    fun `the first administrator cannot be created under a name that differs only in case`() = runBlocking<Unit> {
        createTestUser(nickname = "carol", role = Role.WORKER)

        assertThrows<IllegalStateException> { AdminBootstrapService.createFirstAdmin("Carol", "Carol Admin") }
    }

    @Test
    fun `login stays case-sensitive and the exact name is the account`() = runBlocking<Unit> {
        createTestUser(nickname = "dave", rawPassword = "Password123!")

        val exact = UserService.findPasswordHash(dsl, "dave")
        val other = UserService.findPasswordHash(dsl, "Dave")

        assertNotNull(exact)
        assertNull(other)
    }
}
