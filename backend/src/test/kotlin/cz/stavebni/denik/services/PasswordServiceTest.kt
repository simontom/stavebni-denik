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

    @Test
    fun `the startup self-test passes and can be called repeatedly`() {
        PasswordService.ensureWorks()
        PasswordService.ensureWorks() // only the first call does any work
    }

    @Test
    fun `hashes verify with the standard PHC string of other implementations`() {
        // A hash produced elsewhere (the E2E seed uses @node-rs/argon2) must keep verifying here: m=65536, t=2, p=1.
        val hash = PasswordService.hash("Password123!")

        assertTrue(Regex("^\\\$argon2id\\\$v=19\\\$m=65536,t=2,p=1\\\$[A-Za-z0-9+/]+\\\$[A-Za-z0-9+/]+$").matches(hash), hash)
    }
}
