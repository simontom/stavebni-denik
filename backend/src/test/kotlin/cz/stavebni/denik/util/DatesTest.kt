package cz.stavebni.denik.util

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

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

    @Test
    fun `today is the date in Prague, not in UTC`() {
        fun at(instant: String) = Clock.fixed(Instant.parse(instant), ZoneOffset.UTC)

        // 22:30 UTC on 8 October is 00:30 on the 9th in Prague (summer time, UTC+2).
        assertEquals(LocalDate.of(2026, 10, 9), Dates.today(at("2026-10-08T22:30:00Z")))
        // 23:30 UTC on 1 December is 00:30 on the 2nd (winter time, UTC+1).
        assertEquals(LocalDate.of(2026, 12, 2), Dates.today(at("2026-12-01T23:30:00Z")))
        // Midday is the same date everywhere.
        assertEquals(LocalDate.of(2026, 10, 8), Dates.today(at("2026-10-08T10:00:00Z")))
    }
}
