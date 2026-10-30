package cz.stavebni.denik.services

import cz.stavebni.denik.domain.AppJson
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.Serializable

@Serializable
data class OpenMeteoResponse(
    val current_weather: CurrentWeather? = null
)

@Serializable
data class CurrentWeather(
    val temperature: Double,
    val windspeed: Double,
    val weathercode: Int,
    val time: String
)

/**
 * A client for the Open-Meteo forecast API. **No route calls it** and nothing in the application reaches Open-Meteo: the weather
 * is typed by hand (decision D12). Kept on purpose for a prefill that needs a commercial Open-Meteo key (the free API is
 * non-commercial); it is used only by `WeatherServiceTest` until then.
 */
object WeatherService {
    var baseUrl: String = System.getenv("OPEN_METEO_BASE_URL") ?: "https://api.open-meteo.com/v1/forecast"

    var client: HttpClient = HttpClient(CIO) {
        install(ContentNegotiation) {
            json(AppJson.lenient)
        }
    }

    suspend fun fetchWeather(lat: Double, lon: Double): CurrentWeather? {
        return try {
            val response: OpenMeteoResponse = client.get(baseUrl) {
                parameter("latitude", lat)
                parameter("longitude", lon)
                parameter("current_weather", true)
            }.body()
            response.current_weather
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
}
