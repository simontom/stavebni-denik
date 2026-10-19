package cz.stavebni.denik.util

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.Locale

class CzechFormatTest {

    @Test
    fun `a date is day, month and year without leading zeros`() {
        assertEquals("1. 3. 2026", CzechFormat.date(LocalDate.of(2026, 3, 1)))
        assertEquals("28. 9. 2026", CzechFormat.date(LocalDate.of(2026, 9, 28)))
        assertEquals("31. 12. 2027", CzechFormat.date(LocalDate.of(2027, 12, 31)))
    }

    @Test
    fun `the weekday is in Czech, from Monday to Sunday`() {
        // 28 September 2026 is a Monday.
        val names = (0..6).map { CzechFormat.weekday(LocalDate.of(2026, 9, 28).plusDays(it.toLong())) }
        assertEquals(listOf("pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota", "neděle"), names)
    }

    @Test
    fun `a time of the day is Prague time with the zone, on summer time and on winter time`() {
        // 12:15:30 UTC in July is 14:15:30 on Prague's summer time (UTC+2)...
        assertEquals("1. 7. 2026 14:15:30 SELČ (UTC+2)", CzechFormat.dateTime(OffsetDateTime.parse("2026-07-01T12:15:30Z")))
        // ...and in January 13:15:30 on winter time (UTC+1).
        assertEquals("15. 1. 2026 13:15:30 SEČ (UTC+1)", CzechFormat.dateTime(OffsetDateTime.parse("2026-01-15T12:15:30Z")))
    }

    @Test
    fun `an instant late in the evening in UTC is already the next day in Prague`() {
        // 22:30 UTC on 27 September is 00:30 on 28 September in Prague: the day, and the date, are Prague's.
        val at = OffsetDateTime.parse("2026-09-27T22:30:00Z")
        assertEquals("28. 9. 2026 00:30:00 SELČ (UTC+2)", CzechFormat.dateTime(at))
        assertEquals(LocalDate.of(2026, 9, 28), CzechFormat.pragueDate(at))
    }

    @Test
    fun `an offset other than UTC is converted, not printed as it came`() {
        assertEquals("2. 6. 2026 08:00:00 SELČ (UTC+2)", CzechFormat.dateTime(OffsetDateTime.parse("2026-06-02T09:00:00+03:00")))
    }

    @Test
    @Suppress("DEPRECATION")
    fun `the digits are Latin whatever the default locale of the machine is`() {
        // A document is read the same everywhere: under Arabic or Thai locales the JDK's own formatting would use other digits.
        val saved = Locale.getDefault()
        try {
            for (locale in listOf(Locale("ar", "SA"), Locale("th", "TH", "TH"), Locale("fa", "IR"), Locale("hi", "IN"))) {
                Locale.setDefault(locale)
                assertEquals("1. 7. 2026 04:05:06 SELČ (UTC+2)", CzechFormat.dateTime(OffsetDateTime.parse("2026-07-01T02:05:06Z")), locale.toString())
                assertEquals("1. 7. 2026", CzechFormat.date(LocalDate.of(2026, 7, 1)), locale.toString())
            }
        } finally {
            Locale.setDefault(saved)
        }
    }

    @Test
    fun `the clocks change on the last Sunday of March and of October`() {
        // 29 March 2026: 01:00 UTC is 03:00 summer time; 25 October 2026: 00:59 UTC is 02:59 summer time, 01:00 UTC is 02:00 winter time.
        assertEquals("29. 3. 2026 03:00:00 SELČ (UTC+2)", CzechFormat.dateTime(OffsetDateTime.parse("2026-03-29T01:00:00Z")))
        assertEquals("25. 10. 2026 02:59:00 SELČ (UTC+2)", CzechFormat.dateTime(OffsetDateTime.parse("2026-10-25T00:59:00Z")))
        assertEquals("25. 10. 2026 02:00:00 SEČ (UTC+1)", CzechFormat.dateTime(OffsetDateTime.parse("2026-10-25T01:00:00Z")))
    }
}
