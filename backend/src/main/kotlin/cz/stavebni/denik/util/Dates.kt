package cz.stavebni.denik.util

import java.time.Clock
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * Calendar dates are exchanged with the frontend as `YYYY-MM-DD`.
 *
 * A daily report's date is a real `DATE` column ([parseLocalDate]); the other
 * calendar dates (contract date, handover date …) are still stored as
 * TIMESTAMPTZ at UTC midnight ([parse]).
 */
object Dates {
    /** The site diary is kept in Czech time: "today" is the day on a clock in Prague, not in UTC. */
    val PRAGUE: ZoneId = ZoneId.of("Europe/Prague")

    /** The last Monday-to-Friday day before [date] (Friday for a Saturday, Sunday or Monday). Public holidays are not considered. */
    fun previousWorkingDay(date: LocalDate): LocalDate {
        var day = date.minusDays(1)
        while (day.dayOfWeek == DayOfWeek.SATURDAY || day.dayOfWeek == DayOfWeek.SUNDAY) day = day.minusDays(1)
        return day
    }

    /** Years the diary accepts. ISO dates reach year 999,999,999, which PostgreSQL's DATE cannot hold: that must be a 400, not a 500. */
    private val YEARS = 1900..2200

    private fun plausible(date: LocalDate, original: String): LocalDate {
        if (date.year !in YEARS) throw IllegalArgumentException("Neplatné datum: $original")
        return date
    }

    /** Today's calendar date in Prague. Between 00:00 and 02:00 local time UTC is still on the previous day. */
    fun today(clock: Clock = Clock.system(PRAGUE)): LocalDate = LocalDate.now(clock.withZone(PRAGUE))

    /**
     * Accepts `YYYY-MM-DD` or a full ISO-8601 date-time; a time part is dropped, not
     * converted: the calendar day the client names is the day that is meant.
     */
    fun parseLocalDate(value: String): LocalDate {
        val v = value.trim()
        if (v.isEmpty()) throw IllegalArgumentException("Chybí datum")
        return try {
            plausible(LocalDate.parse(v.substringBefore("T")), value)
        } catch (e: Exception) {
            throw IllegalArgumentException("Neplatné datum: $value")
        }
    }

    /** Accepts `YYYY-MM-DD` or a full ISO-8601 offset date-time; blank → null. */
    fun parseOrNull(value: String?): OffsetDateTime? {
        if (value.isNullOrBlank()) return null
        val v = value.trim()
        return try {
            if (v.length == 10) plausible(LocalDate.parse(v), value).atStartOfDay().atOffset(ZoneOffset.UTC)
            else OffsetDateTime.parse(v).also { plausible(it.toLocalDate(), value) }
        } catch (e: Exception) {
            throw IllegalArgumentException("Neplatné datum: $value")
        }
    }

    fun parse(value: String): OffsetDateTime =
        parseOrNull(value) ?: throw IllegalArgumentException("Chybí datum")

    /** UTC calendar date as `YYYY-MM-DD`. */
    fun format(value: OffsetDateTime?): String? =
        value?.withOffsetSameInstant(ZoneOffset.UTC)?.toLocalDate()?.toString()

    fun formatInstant(value: OffsetDateTime?): String? = value?.toString()
}
