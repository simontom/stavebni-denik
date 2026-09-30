package cz.stavebni.denik.domain

import kotlinx.serialization.Serializable

@Serializable
data class WeatherData(
    val tempMin: Double? = null,
    val tempMax: Double? = null,
    val condition: String? = null
)

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

@Serializable
data class NotificationPayload(
    val projectId: String? = null,
    val message: String,
    val actionUrl: String? = null
)
