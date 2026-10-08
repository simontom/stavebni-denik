package cz.stavebni.denik.routes

import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.services.JwtService
import cz.stavebni.denik.services.PasswordService
import cz.stavebni.denik.services.SessionService
import cz.stavebni.denik.services.UserService
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import cz.stavebni.denik.domain.SessionUser
import kotlinx.serialization.Serializable

@Serializable
data class LoginRequest(val nickname: String, val password: String)

@Serializable
data class LoginResponse(val status: String, val user: SessionUser)

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

            // A real server-side session: the token below only names it, and revoking the
            // session (logout, deactivation, ...) ends the access at once.
            val session = SessionService.create(DatabaseFactory.dsl, user.id)
            val sessionUser = user.copy(sessionId = session.id)
            val token = JwtService.createToken(sessionUser, session.expiresAt.toInstant())

            // Set HttpOnly cookie
            call.response.cookies.append(
                name = "jwt",
                value = token,
                httpOnly = true,
                path = "/",
                maxAge = SessionService.LIFETIME.seconds,
                secure = AppConfig.isProduction,
                extensions = mapOf("SameSite" to "Lax")
            )

            call.respond(LoginResponse(status = "ok", user = sessionUser))
        }

        post("/api/auth/logout") {
            // Clearing the cookie is not enough: a copied token would stay valid. End the session itself.
            val token = call.request.cookies["jwt"]
                ?: call.request.headers[HttpHeaders.Authorization]?.removePrefix("Bearer ")?.trim()
            token
                ?.let { JwtService.verify(it) }
                ?.let { JwtService.decodeUser(it) }
                ?.let { SessionService.revoke(DatabaseFactory.dsl, it.sessionId) }

            call.response.cookies.append(
                name = "jwt",
                value = "",
                httpOnly = true,
                path = "/",
                maxAge = 0,
                secure = AppConfig.isProduction,
                extensions = mapOf("SameSite" to "Lax")
            )
            call.respond(mapOf("status" to "ok"))
        }
    }
}
