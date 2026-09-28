package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.services.JwtService
import cz.stavebni.denik.services.PasswordService
import cz.stavebni.denik.services.UserService
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.temporal.ChronoUnit

@Serializable
data class LoginRequest(val nickname: String, val password: String)

fun Application.authRoutes() {
    routing {
        post("/api/auth/login") {
            val req = call.receive<LoginRequest>()
            
            // Note: Not using auditedTransaction here because we just SELECT
            val hash = UserService.findPasswordHash(DatabaseFactory.dsl, req.nickname)
            if (hash == null || !PasswordService.verify(hash, req.password)) {
                call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Invalid credentials"))
                return@post
            }

            val user = UserService.findUserByNickname(DatabaseFactory.dsl, req.nickname)
            if (user == null) {
                call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Invalid credentials"))
                return@post
            }

            // Create JWT token for 7 days
            val token = JwtService.createToken(user, Instant.now().plus(7, ChronoUnit.DAYS))
            
            // Set HttpOnly cookie
            call.response.cookies.append(
                name = "jwt",
                value = token,
                httpOnly = true,
                path = "/",
                maxAge = 7 * 24 * 60 * 60,
                secure = false // true in production
            )

            call.respond(mapOf("status" to "ok", "user" to user))
        }

        post("/api/auth/logout") {
            call.response.cookies.append(
                name = "jwt",
                value = "",
                httpOnly = true,
                path = "/",
                maxAge = 0
            )
            call.respond(mapOf("status" to "ok"))
        }
    }
}
