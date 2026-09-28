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

@Serializable
data class MeterState(
    val meterId: String,
    val value: Double,
    val unit: String? = null
)

@Serializable
data class NotificationPayload(
    val projectId: String? = null,
    val message: String,
    val actionUrl: String? = null
)
