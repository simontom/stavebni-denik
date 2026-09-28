package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

class JwtServiceTest {

    @Test
    fun `createToken creates valid token decodeable into SessionUser`() {
        val user = SessionUser(
            id = UUID.randomUUID(),
            nickname = "test_jwt_user",
            displayName = "JWT User",
            role = Role.INSPECTOR,
            isAdmin = true,
            mustChangePwd = false,
            sessionId = UUID.randomUUID()
        )

        val token = JwtService.createToken(user, Instant.now().plus(1, ChronoUnit.HOURS))
        assertNotNull(token)

        val decodedJwt = JwtService.verify(token)
        assertNotNull(decodedJwt)

        val decodedUser = JwtService.decodeUser(decodedJwt!!)
        assertNotNull(decodedUser)
        assertEquals(user.id, decodedUser!!.id)
        assertEquals(user.nickname, decodedUser.nickname)
        assertEquals(user.displayName, decodedUser.displayName)
        assertEquals(user.role, decodedUser.role)
        assertEquals(user.isAdmin, decodedUser.isAdmin)
        assertEquals(user.sessionId, decodedUser.sessionId)
    }

    @Test
    fun `verify returns null for invalid or tampered token`() {
        assertNull(JwtService.verify("invalid.token.here"))
    }
}
