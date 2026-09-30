package cz.stavebni.denik.util

import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * Calendar dates (contract date, handover date, report date …) are stored as
 * TIMESTAMPTZ at UTC midnight and exchanged with the frontend as `YYYY-MM-DD`.
 */
object Dates {
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
