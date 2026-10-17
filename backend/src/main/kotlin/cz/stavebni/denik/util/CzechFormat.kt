package cz.stavebni.denik.util

import java.time.LocalDate
import java.time.OffsetDateTime

/**
 * Dates and times as people read them in a document: `28. 9. 2026`, and a time of the day in Prague time with its zone,
 * `28. 9. 2026 14:32:07 SELČ (UTC+2)`. The API and the database keep ISO dates and UTC instants; this is only for what is
 * printed. The names and the zone abbreviations are written out here instead of taken from the JDK's locale data, so the
 * result does not depend on the machine the server runs on.
 */
object CzechFormat {
    private val WEEKDAYS = listOf("pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota", "neděle")

    /** `28. 9. 2026`: day, month and year, no leading zeros. */
    fun date(date: LocalDate): String = "${date.dayOfMonth}. ${date.monthValue}. ${date.year}"

    /** `pondělí` for a Monday. */
    fun weekday(date: LocalDate): String = WEEKDAYS[date.dayOfWeek.value - 1]

    /** The calendar day in Prague at the moment [at]: after 22:00 or 23:00 UTC that is already the next day. */
    fun pragueDate(at: OffsetDateTime): LocalDate = at.atZoneSameInstant(Dates.PRAGUE).toLocalDate()

    /**
     * `28. 9. 2026 14:32:07 SELČ (UTC+2)`: the moment [at] on the clock in Prague, with the zone it was read in (SEČ, the
     * central European time, or SELČ, its summer time) and its offset, so the time cannot be mistaken for another zone.
     */
    fun dateTime(at: OffsetDateTime): String {
        val local = at.atZoneSameInstant(Dates.PRAGUE)
        val summer = local.zone.rules.isDaylightSavings(local.toInstant())
        val time = "%02d:%02d:%02d".format(local.hour, local.minute, local.second)
        val zone = if (summer) "SELČ" else "SEČ"
        return "${date(local.toLocalDate())} $time $zone (UTC+${local.offset.totalSeconds / 3600})"
    }
}
