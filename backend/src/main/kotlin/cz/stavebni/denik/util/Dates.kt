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
            LocalDate.parse(v.substringBefore("T"))
        } catch (e: Exception) {
            throw IllegalArgumentException("Neplatné datum: $value")
        }
    }

    /** Accepts `YYYY-MM-DD` or a full ISO-8601 offset date-time; blank → null. */
    fun parseOrNull(value: String?): OffsetDateTime? {
        if (value.isNullOrBlank()) return null
        val v = value.trim()
        return try {
            if (v.length == 10) LocalDate.parse(v).atStartOfDay().atOffset(ZoneOffset.UTC)
            else OffsetDateTime.parse(v)
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
