package cz.stavebni.denik.util

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class TextTest {

    /** U+1F600: one character for a person, two UTF-16 code units in a Java string. */
    private val emoji = "😀"

    @Test
    fun `a text of exactly the limit passes unchanged and one character more is refused with the limit in the message`() {
        assertEquals("a".repeat(200), Text.checked("a".repeat(200), "Jméno", 200))

        val tooLong = assertThrows<IllegalArgumentException> { Text.checked("a".repeat(201), "Jméno", 200) }
        assertEquals("Jméno může mít nejvýše 200 znaků", tooLong.message)
    }

    @Test
    fun `a character outside the basic plane counts once, like any other character`() {
        assertEquals(2, emoji.length, "the premise: two UTF-16 code units")

        // 200 emoji are 200 characters (400 code units): at the limit, so accepted
        assertEquals(emoji.repeat(200), Text.checked(emoji.repeat(200), "Jméno", 200))
        // 199 letters and one emoji are 200 characters as well
        assertEquals("a".repeat(199) + emoji, Text.checked("a".repeat(199) + emoji, "Jméno", 200))

        // one more is 201 characters
        assertThrows<IllegalArgumentException> { Text.checked(emoji.repeat(201), "Jméno", 200) }
        val tooLong = assertThrows<IllegalArgumentException> { Text.checked("a".repeat(200) + emoji, "Jméno", 200) }
        assertTrue(tooLong.message!!.contains("nejvýše 200 znaků"), tooLong.message)
    }

    @Test
    fun `an empty text is fine and a NUL character is refused wherever it is`() {
        assertEquals("", Text.checked("", "Jméno", 200))

        for (text in listOf("\u0000", "a\u0000", "\u0000a", "a\u0000b", emoji + "\u0000")) {
            val refused = assertThrows<IllegalArgumentException> { Text.checked(text, "Jméno", 200) }
            assertEquals("Jméno obsahuje nepovolený znak (NUL)", refused.message)
        }
    }
}
