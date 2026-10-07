package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.module
import cz.stavebni.denik.services.CreateUserRequest
import cz.stavebni.denik.services.CreateUserResponse
import cz.stavebni.denik.services.UpdateUserRequest
import cz.stavebni.denik.services.UserDto
import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class UserRoutesTest : BaseIntegrationTest() {

    private fun ApplicationTestBuilder.jsonClient() = createClient {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
    }

    @Test
    fun `admin manages the full user lifecycle and new user can log in`() = testApplication {
        application { module() }
        val client = jsonClient()
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val token = generateJwtToken(admin)

        // create
        val createResp = client.post("/api/users") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(CreateUserRequest(nickname = "novy.delnik", displayName = "Nový Dělník"))
        }
        assertEquals(HttpStatusCode.Created, createResp.status)
        val created = createResp.body<CreateUserResponse>()
        assertEquals("WORKER", created.user.role)
        assertTrue(created.user.mustChangePwd)
        assertTrue(created.initialPassword.length >= 12)

        // the generated password works
        val login = client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest("novy.delnik", created.initialPassword))
        }
        assertEquals(HttpStatusCode.OK, login.status)

        // duplicate nickname -> 409
        val dup = client.post("/api/users") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(CreateUserRequest(nickname = "novy.delnik", displayName = "Jiný"))
        }
        assertEquals(HttpStatusCode.Conflict, dup.status)

        // update
        val id = created.user.id
        val upd = client.patch("/api/users/$id") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(UpdateUserRequest(displayName = "Nový Dělník (upraveno)"))
        }
        assertEquals(HttpStatusCode.OK, upd.status)
        assertEquals("Nový Dělník (upraveno)", upd.body<UserDto>().displayName)

        // deactivate -> login rejected
        val deact = client.post("/api/users/$id/deactivate") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertFalse(deact.body<UserDto>().isActive)
        val loginInactive = client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest("novy.delnik", created.initialPassword))
        }
        assertEquals(HttpStatusCode.Unauthorized, loginInactive.status)

        // activate again
        val act = client.post("/api/users/$id/activate") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertTrue(act.body<UserDto>().isActive)

        // delete -> no longer listed
        val del = client.delete("/api/users/$id") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.NoContent, del.status)
        val list = client.get("/api/users") { header(HttpHeaders.Authorization, "Bearer $token") }.body<List<UserDto>>()
        assertTrue(list.none { it.id == id })
        assertTrue(list.any { it.id == admin.id.toString() })
    }

    @Test
    fun `non-admin cannot manage users but a BOSS can list user options`() = testApplication {
        application { module() }
        val client = jsonClient()
        val boss = createTestUser(role = Role.BOSS, isAdmin = false)
        val token = generateJwtToken(boss)

        val list = client.get("/api/users") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.Forbidden, list.status)

        val create = client.post("/api/users") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(CreateUserRequest(nickname = "hacker", displayName = "X"))
        }
        assertEquals(HttpStatusCode.Forbidden, create.status)

        val options = client.get("/api/users/options") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.OK, options.status)

        val worker = createTestUser(role = Role.WORKER)
        val workerOptions = client.get("/api/users/options") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(worker)}")
        }
        assertEquals(HttpStatusCode.Forbidden, workerOptions.status)
    }

    @Test
    fun `admin cannot deactivate or delete own account`() = testApplication {
        application { module() }
        val client = jsonClient()
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val token = generateJwtToken(admin)

        val deact = client.post("/api/users/${admin.id}/deactivate") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.BadRequest, deact.status)
        val del = client.delete("/api/users/${admin.id}") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.BadRequest, del.status)
    }
}
