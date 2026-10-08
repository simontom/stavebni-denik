package cz.stavebni.denik.services

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PasswordPolicyTest {

    @Test
    fun `a long password with all character classes is acceptable`() {
        assertEquals(emptyList<String>(), PasswordPolicy.issues("Nov3-Heslo-Pro-Test!"))
    }

    @Test
    fun `every missing rule is reported`() {
        assertTrue(PasswordPolicy.issues("Ab1!").single().contains("alespoň 12 znaků"))
        assertTrue(PasswordPolicy.issues("ABCDEFGHIJK1!").single().contains("malé písmeno"))
        assertTrue(PasswordPolicy.issues("abcdefghijk1!").single().contains("velké písmeno"))
        assertTrue(PasswordPolicy.issues("Abcdefghijkl!").single().contains("číslici"))
        assertTrue(PasswordPolicy.issues("Abcdefghijk12").single().contains("speciální znak"))
    }

    @Test
    fun `several problems are all listed`() {
        assertEquals(5, PasswordPolicy.issues("").size)
    }

    @Test
    fun `a password over the maximum length is refused`() {
        val tooLong = "Aa1!" + "x".repeat(PasswordPolicy.MAX_LENGTH)
        assertTrue(PasswordPolicy.issues(tooLong).single().contains("nejvýše"))
    }

    @Test
    fun `non ASCII letters do not count as special characters`() {
        // Only [A-Za-z0-9] are "plain"; accented letters would count as special in the legacy rule too.
        assertTrue(PasswordPolicy.issues("Abcdefghij1ž").isEmpty())
    }
}
