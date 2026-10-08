package cz.stavebni.denik.plugins

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CrossSiteGuardTest {

    private val host = "denik.example"
    private fun cross(secFetchSite: String? = null, origin: String? = null, host: String? = this.host, allowed: List<String> = emptyList()) =
        isCrossSite(secFetchSite, origin, host, allowed)

    @Test
    fun `Sec-Fetch-Site decides when the browser sends it`() {
        assertFalse(cross(secFetchSite = "same-origin"))
        assertFalse(cross(secFetchSite = "none"))
        assertFalse(cross(secFetchSite = "Same-Origin"))
        assertTrue(cross(secFetchSite = "cross-site"))
        assertTrue(cross(secFetchSite = "same-site"))
        assertTrue(cross(secFetchSite = "something-new"))
    }

    @Test
    fun `Sec-Fetch-Site wins over an Origin that looks fine`() {
        assertTrue(cross(secFetchSite = "cross-site", origin = "https://denik.example"))
    }

    @Test
    fun `without Sec-Fetch-Site the Origin host has to be the host the request was sent to`() {
        assertFalse(cross(origin = "https://denik.example"))
        assertFalse(cross(origin = "http://DENIK.example"))
        assertTrue(cross(origin = "https://evil.example"))
        assertTrue(cross(origin = "https://denik.example.evil.example"))
        assertTrue(cross(origin = "null"))
        assertTrue(cross(origin = "https://denik.example", host = null))
        assertFalse(cross(origin = "http://localhost:8080", host = "localhost:8080"))
        assertTrue(cross(origin = "http://localhost:5173", host = "localhost:8080"))
    }

    @Test
    fun `an origin on the CORS allow list is accepted whatever the browser says about the site`() {
        val allowed = listOf("https://spa.example")
        assertFalse(cross(secFetchSite = "cross-site", origin = "https://spa.example", allowed = allowed))
        assertFalse(cross(origin = "https://spa.example/", allowed = allowed))
        assertTrue(cross(secFetchSite = "cross-site", origin = "https://other.example", allowed = allowed))
    }

    @Test
    fun `requests without either header are not browser cross-site requests`() {
        assertFalse(cross())
    }
}
