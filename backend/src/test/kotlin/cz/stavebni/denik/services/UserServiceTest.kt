package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class UserServiceTest : BaseIntegrationTest() {

    @Test
    fun `findUserByNickname and findPasswordHash query user credentials correctly`() = runBlocking {
        val user = createTestUser(
            nickname = "karel_stavitel",
            displayName = "Karel Stavitel",
            role = Role.BOSS,
            isAdmin = false,
            rawPassword = "SecretPassword123!"
        )

        // 1. Find by nickname
        val found = UserService.findUserByNickname(dsl, "karel_stavitel")
        assertNotNull(found)
        assertEquals(user.id, found!!.id)
        assertEquals("karel_stavitel", found.nickname)
        assertEquals("Karel Stavitel", found.displayName)
        assertEquals(Role.BOSS, found.role)

        // 2. Non-existent user
        val notFound = UserService.findUserByNickname(dsl, "non_existent")
        assertNull(notFound)

        // 3. Password hash verification
        val hash = UserService.findPasswordHash(dsl, "karel_stavitel")
        assertNotNull(hash)
        assertTrue(PasswordService.verify(hash!!, "SecretPassword123!"))
        assertFalse(PasswordService.verify(hash, "WrongPassword"))
    }
}
