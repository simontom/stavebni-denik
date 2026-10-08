package cz.stavebni.denik.util

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.LocalDate

class DatesTest {

    @Test
    fun `parseLocalDate accepts a plain calendar date`() {
        assertEquals(LocalDate.of(2026, 9, 28), Dates.parseLocalDate("2026-09-28"))
        assertEquals(LocalDate.of(2026, 9, 28), Dates.parseLocalDate("  2026-09-28 "))
    }

    @Test
    fun `parseLocalDate drops a time part instead of converting it`() {
        // 23:30 at +02:00 is already the next day in UTC, but the client named the 28th.
        assertEquals(LocalDate.of(2026, 9, 28), Dates.parseLocalDate("2026-09-28T23:30:00+02:00"))
        assertEquals(LocalDate.of(2026, 9, 28), Dates.parseLocalDate("2026-09-28T00:00:00Z"))
    }

    @Test
    fun `parseLocalDate rejects blank and invalid input with a readable message`() {
        assertThrows<IllegalArgumentException> { Dates.parseLocalDate("") }
        assertThrows<IllegalArgumentException> { Dates.parseLocalDate("   ") }
        val error = assertThrows<IllegalArgumentException> { Dates.parseLocalDate("28.9.2026") }
        assertTrue(error.message!!.contains("28.9.2026"))
        assertThrows<IllegalArgumentException> { Dates.parseLocalDate("2026-02-30") }
    }
}
