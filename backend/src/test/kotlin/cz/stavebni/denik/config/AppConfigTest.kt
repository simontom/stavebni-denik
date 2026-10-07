package cz.stavebni.denik.config

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The release guard keeps an unreleased build from starting in production mode
 * by accident. AppConfig reads environment variables and, as a fallback, JVM
 * system properties (which is what these tests set).
 */
class AppConfigTest {

    private val keys = listOf("APP_ENV", "ALLOW_UNRELEASED_BUILD")

    @AfterEach
    fun clearProperties() {
        keys.forEach { System.clearProperty(it) }
    }

    @Test
    fun `development mode starts without any opt-in`() {
        assertDoesNotThrow { AppConfig.requireReleaseOptIn() }
    }

    @Test
    fun `production mode without the opt-in refuses to start`() {
        System.setProperty("APP_ENV", "production")

        val error = assertThrows(IllegalStateException::class.java) { AppConfig.requireReleaseOptIn() }
        assertTrue(error.message!!.contains("ALLOW_UNRELEASED_BUILD"), "the message must name the switch")
    }

    @Test
    fun `production mode is detected case-insensitively`() {
        System.setProperty("APP_ENV", "Production")

        assertThrows(IllegalStateException::class.java) { AppConfig.requireReleaseOptIn() }
    }

    @Test
    fun `production mode starts with ALLOW_UNRELEASED_BUILD=true`() {
        System.setProperty("APP_ENV", "production")
        System.setProperty("ALLOW_UNRELEASED_BUILD", "true")

        assertTrue(AppConfig.allowUnreleasedBuild)
        assertDoesNotThrow { AppConfig.requireReleaseOptIn() }
    }

    @Test
    fun `only the exact value true counts as opt-in`() {
        System.setProperty("APP_ENV", "production")

        for (value in listOf("false", "yes", "1", "")) {
            System.setProperty("ALLOW_UNRELEASED_BUILD", value)
            assertFalse(AppConfig.allowUnreleasedBuild, "'$value' must not count as opt-in")
            assertThrows(IllegalStateException::class.java) { AppConfig.requireReleaseOptIn() }
        }
    }
}
