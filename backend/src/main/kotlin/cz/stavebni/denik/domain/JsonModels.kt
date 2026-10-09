package cz.stavebni.denik.domain

import kotlinx.serialization.Serializable

/**
 * The weather of a diary day, entered by hand (decision D12). Everything is optional; an entry without any value is
 * "not stated" and is stored as no weather at all.
 */
@Serializable
data class WeatherData(
    val tempMin: Double? = null,
    val tempMax: Double? = null,
    val condition: String? = null
) {
    /** True when nothing is stated. */
    fun isEmpty(): Boolean = tempMin == null && tempMax == null && condition.isNullOrBlank()

    /** The entry as stored: trimmed text, nothing stated = null. Fails with a readable message when a value is implausible. */
    fun validated(): WeatherData? {
        val text = condition?.trim()?.takeIf { it.isNotEmpty() }
        require((text?.length ?: 0) <= MAX_CONDITION_CHARS) { "Popis počasí může mít nejvýše $MAX_CONDITION_CHARS znaků" }
        for ((name, value) in listOf("Nejnižší" to tempMin, "Nejvyšší" to tempMax)) {
            require(value == null || (value.isFinite() && value in MIN_TEMP..MAX_TEMP)) {
                "$name teplota musí být mezi $MIN_TEMP a $MAX_TEMP °C"
            }
        }
        require(tempMin == null || tempMax == null || tempMin <= tempMax) { "Nejnižší teplota nemůže být vyšší než nejvyšší" }
        return WeatherData(tempMin, tempMax, text).takeUnless { it.isEmpty() }
    }

    /** Readable Czech text, for the PDF and the audit snapshot (which keeps no decimals): "zataženo, 8,5 až 15 °C". */
    fun describe(): String {
        val parts = mutableListOf<String>()
        condition?.trim()?.takeIf { it.isNotEmpty() }?.let { parts += it }
        when {
            tempMin != null && tempMax != null -> parts += "${degrees(tempMin)} až ${degrees(tempMax)} °C"
            tempMin != null -> parts += "min. ${degrees(tempMin)} °C"
            tempMax != null -> parts += "max. ${degrees(tempMax)} °C"
        }
        return parts.joinToString(", ")
    }

    private fun degrees(value: Double): String = java.math.BigDecimal.valueOf(value).stripTrailingZeros().toPlainString().replace('.', ',')

    companion object {
        const val MAX_CONDITION_CHARS = 200
        const val MIN_TEMP = -60.0
        const val MAX_TEMP = 60.0
    }
}

@Serializable
data class WorkerEntry(
    val trade: String,
    val count: Int
)

@Serializable
data class MeetingAttendee(
    val name: String,
    val role: String,
    val organization: String? = null
)

@Serializable
data class GpsCoords(
    val lat: Double,
    val lon: Double
)

/** Meter reading recorded in a site handover protocol (e.g. "Elektřina VT", "EL-98765", "12450 kWh"). */
@Serializable
data class MeterState(
    val medium: String = "",
    val serialNumber: String = "",
    val state: String = ""
)
