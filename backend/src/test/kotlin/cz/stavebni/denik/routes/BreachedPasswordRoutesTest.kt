package cz.stavebni.denik.routes

import com.github.tomakehurst.wiremock.WireMockServer
import com.github.tomakehurst.wiremock.client.WireMock.*
import com.github.tomakehurst.wiremock.core.WireMockConfiguration.options
import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.BreachedPasswordService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.security.MessageDigest

/** Changing a password refuses one from a known breach, and records when the user chose a password. */
class BreachedPasswordRoutesTest : BaseIntegrationTest() {

    private lateinit var server: WireMockServer
    private val originalUrl = BreachedPasswordService.baseUrl

    private fun sha1(password: String) =
        MessageDigest.getInstance("SHA-1").digest(password.toByteArray()).joinToString("") { "%02X".format(it) }

    @BeforeEach
    fun startServer() {
        server = WireMockServer(options().dynamicPort())
        server.start()
        BreachedPasswordService.baseUrl = "http://localhost:${server.port()}/range"
    }

    @AfterEach
    fun stopServer() {
        server.stop()
        BreachedPasswordService.baseUrl = originalUrl
    }

    private fun listAsBreached(password: String) {
        val hash = sha1(password)
        server.stubFor(get(urlEqualTo("/range/${hash.take(5)}")).willReturn(aResponse().withBody("${hash.drop(5)}:12345")))
    }

    private fun listNothing() {
        server.stubFor(get(urlPathMatching("/range/.*")).willReturn(aResponse().withBody("00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2")))
    }

    private suspend fun ApplicationTestBuilder.change(token: String, current: String, new: String): HttpResponse =
        client.post("/api/auth/change-password") {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.Authorization, "Bearer $token")
            setBody("""{"currentPassword":"$current","newPassword":"$new"}""")
        }

    private fun row(id: java.util.UUID) = dsl.selectFrom(USERS).where(USERS.ID.eq(id)).fetchOne()!!

    @Test
    fun `a password from a known breach is refused and nothing changes`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS, rawPassword = "Old-Password-1!")
        val token = generateJwtToken(user)
        listAsBreached("Summer2024!x")
        val hashBefore = row(user.id).passwordhash

        val response = change(token, "Old-Password-1!", "Summer2024!x")

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(response.bodyAsText().contains("uniklých"), response.bodyAsText())
        assertEquals(hashBefore, row(user.id).passwordhash)
        assertNull(row(user.id).passwordchangedat)
    }

    @Test
    fun `a password that is not in a breach is accepted and the change is recorded`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS, rawPassword = "Old-Password-1!")
        val token = generateJwtToken(user)
        listNothing()

        val response = change(token, "Old-Password-1!", "Nov3-Heslo-Pro-Test!")

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertNotNull(row(user.id).passwordchangedat, "the time the user chose a password is recorded")
    }

    @Test
    fun `an outage of the breach service does not stop a password change`() = testApplication {
        application { module() }
        val user = createTestUser(role = Role.BOSS, rawPassword = "Old-Password-1!")
        val token = generateJwtToken(user)
        server.stubFor(get(urlPathMatching("/range/.*")).willReturn(aResponse().withStatus(503)))

        val response = change(token, "Old-Password-1!", "Nov3-Heslo-Pro-Test!")

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
    }

    @Test
    fun `a reset by an administrator clears the recorded time because the new password is temporary`() = testApplication {
        application { module() }
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val target = createTestUser(role = Role.WORKER, rawPassword = "Old-Password-1!")
        dsl.update(USERS).set(USERS.PASSWORDCHANGEDAT, java.time.OffsetDateTime.now()).where(USERS.ID.eq(target.id)).execute()

        val response = client.post("/api/users/${target.id}/reset-password") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(admin)}")
        }

        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertNull(row(target.id).passwordchangedat)
    }
}
