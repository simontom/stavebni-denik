package cz.stavebni.denik.services

import com.github.tomakehurst.wiremock.WireMockServer
import com.github.tomakehurst.wiremock.client.WireMock.*
import com.github.tomakehurst.wiremock.core.WireMockConfiguration.options
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class WeatherServiceTest {

    private lateinit var wireMockServer: WireMockServer
    private val originalBaseUrl = WeatherService.baseUrl

    @BeforeAll
    fun setUp() {
        wireMockServer = WireMockServer(options().dynamicPort())
        wireMockServer.start()
        WeatherService.baseUrl = "http://localhost:${wireMockServer.port()}/v1/forecast"
    }

    @AfterAll
    fun tearDown() {
        wireMockServer.stop()
        WeatherService.baseUrl = originalBaseUrl
    }

    @Test
    fun `fetchWeather parses current weather correctly from OpenMeteo endpoint`() = runBlocking {
        wireMockServer.stubFor(
            get(urlPathEqualTo("/v1/forecast"))
                .withQueryParam("latitude", equalTo("50.08"))
                .withQueryParam("longitude", equalTo("14.43"))
                .withQueryParam("current_weather", equalTo("true"))
                .willReturn(
                    aResponse()
                        .withHeader("Content-Type", "application/json")
                        .withBody(
                            """
                            {
                                "current_weather": {
                                    "temperature": 19.4,
                                    "windspeed": 11.2,
                                    "weathercode": 2,
                                    "time": "2026-09-28T14:00"
                                }
                            }
                            """.trimIndent()
                        )
                )
        )

        val weather = WeatherService.fetchWeather(50.08, 14.43)
        assertNotNull(weather)
        assertEquals(19.4, weather.temperature)
        assertEquals(11.2, weather.windspeed)
        assertEquals(2, weather.weathercode)
        assertEquals("2026-09-28T14:00", weather.time)
    }

    @Test
    fun `fetchWeather gracefully returns null on HTTP 500 error`() = runBlocking {
        wireMockServer.stubFor(
            get(urlPathEqualTo("/v1/forecast"))
                .withQueryParam("latitude", equalTo("0.0"))
                .willReturn(aResponse().withStatus(500))
        )

        val weather = WeatherService.fetchWeather(0.0, 0.0)
        assertNull(weather)
    }
}
