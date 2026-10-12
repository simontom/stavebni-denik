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
        assertTrue(PasswordPolicy.issues("Kvetinazahrada!").single().contains("číslici"))
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

    @Test
    fun `a common word is refused however many digits and symbols surround it`() {
        for (password in listOf("Password123456!", "Heslo123456!!", "Qwertz123456!", "P@ssw0rd!2024")) {
            val issues = PasswordPolicy.issues(password)
            assertEquals(1, issues.size, "$password: $issues")
            assertTrue(issues.single().contains("běžné"), "$password: $issues")
        }
    }

    @Test
    fun `case and diacritics do not hide a common word`() {
        assertTrue(PasswordPolicy.isCommon("STAVEBNÍ-denik-1!"))
        assertTrue(PasswordPolicy.isCommon("Stavební Deník 99#"))
    }

    @Test
    fun `a password is not refused merely because it contains a common word`() {
        assertTrue(PasswordPolicy.issues("Heslo-Je-Dlouhe-A-Neobvykle-7!").isEmpty())
        assertTrue(!PasswordPolicy.isCommon("Kvetina-9-Zahrada!"))
    }

    @Test
    fun `a password that contains the login name is refused, whatever its case`() {
        val issues = PasswordPolicy.issues("Xx-NOVAK.Jan-2026!", nickname = "novak.jan")
        assertTrue(issues.single().contains("přihlašovací jméno"), issues.toString())
    }

    @Test
    fun `very short login names and a missing login name are not looked for`() {
        assertTrue(PasswordPolicy.issues("Kvetina-9-Zahrada!", nickname = "ka").isEmpty())
        assertTrue(PasswordPolicy.issues("Xx-Novak.Jan-2026!").isEmpty())
        assertTrue(PasswordPolicy.issues("Xx-Novak.Jan-2026!", nickname = "   ").isEmpty())
    }
}
