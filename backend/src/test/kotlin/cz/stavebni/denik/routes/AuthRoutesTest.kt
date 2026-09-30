package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.module
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AuthRoutesTest : BaseIntegrationTest() {

    @Test
    fun `login with valid credentials sets jwt cookie and returns ok`() = testApplication {
        application {
            module()
        }

        val client = createClient {
            install(ContentNegotiation) {
                json()
            }
        }

        createTestUser(
            nickname = "auth_tester",
            displayName = "Auth Tester",
            role = Role.BOSS,
            rawPassword = "Password123!"
        )

        val response = client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(nickname = "auth_tester", password = "Password123!"))
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("\"status\":\"ok\""))
        assertTrue(body.contains("auth_tester"))

        val setCookieHeader = response.headers[HttpHeaders.SetCookie]
        assertNotNull(setCookieHeader)
        assertTrue(setCookieHeader!!.contains("jwt="))
        assertTrue(setCookieHeader.contains("HttpOnly"))
    }

    @Test
    fun `login with invalid password returns 401 Unauthorized`() = testApplication {
        application {
            module()
        }

        val client = createClient {
            install(ContentNegotiation) {
                json()
            }
        }

        createTestUser(nickname = "auth_user_wrong", rawPassword = "CorrectPassword123!")

        val response = client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(nickname = "auth_user_wrong", password = "WrongPassword"))
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `logout clears jwt cookie`() = testApplication {
        application {
            module()
        }

        val client = createClient {
            install(ContentNegotiation) {
                json()
            }
        }

        val response = client.post("/api/auth/logout")
        assertEquals(HttpStatusCode.OK, response.status)

        val setCookieHeader = response.headers[HttpHeaders.SetCookie]
        assertNotNull(setCookieHeader)
        assertTrue(setCookieHeader!!.contains("jwt="))
        assertTrue(setCookieHeader.contains("Max-Age=0") || setCookieHeader.contains("max-age=0"))
    }
}
