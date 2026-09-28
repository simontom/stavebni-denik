package cz.stavebni.denik.services

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PasswordServiceTest {

    @Test
    fun `hash produces Argon2id hash that verifies successfully`() {
        val password = "SuperSecretPassword123!"
        val hash = PasswordService.hash(password)

        assertTrue(hash.startsWith("\$argon2id\$"))
        assertTrue(PasswordService.verify(hash, password))
        assertFalse(PasswordService.verify(hash, "WrongPassword123!"))
    }
}
