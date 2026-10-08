package cz.stavebni.denik.routes

import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.TooManyRequestsException
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.plugins.clientIp
import cz.stavebni.denik.services.ChangePasswordRequest
import cz.stavebni.denik.services.JwtService
import cz.stavebni.denik.services.PasswordPolicy
import cz.stavebni.denik.services.PasswordService
import cz.stavebni.denik.services.RateLimiter
import cz.stavebni.denik.services.SessionService
import cz.stavebni.denik.services.UserService
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable

private const val MAX_NICKNAME_LENGTH = 128

@Serializable
data class LoginRequest(val nickname: String, val password: String)

@Serializable
data class LoginResponse(val status: String, val user: SessionUser)

fun Application.authRoutes() {
    routing {
        post("/api/auth/login") {
            val req = call.receive<LoginRequest>()
            val nickname = req.nickname.trim()
            if (nickname.isEmpty() || nickname.length > MAX_NICKNAME_LENGTH || req.password.isEmpty() || req.password.length > PasswordPolicy.MAX_LENGTH) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Neplatné přihlašovací údaje"))
                return@post
            }

            val db = DatabaseFactory.dsl
            val ip = call.clientIp()
            val userKey = UserService.loginKey(nickname)

            // Too many failures from this address or against this name: refuse before any password work is done.
            val wait = listOfNotNull(
                RateLimiter.retryAfter(db, RateLimiter.Rules.LOGIN_IP, ip),
                RateLimiter.retryAfter(db, RateLimiter.Rules.LOGIN_USER, userKey),
            ).maxOrNull()
            if (wait != null) {
                throw TooManyRequestsException(
                    wait.seconds,
                    "Příliš mnoho neúspěšných pokusů o přihlášení. Zkuste to znovu za ${RateLimiter.describeWait(wait)}."
                )
            }

            // Unknown, deactivated and deleted accounts cost the same time as a wrong password and get the same answer.
            val hash = UserService.findPasswordHash(db, nickname)
            val passwordOk = if (hash == null) PasswordService.verifyAgainstNobody(req.password) else PasswordService.verifyAsync(hash, req.password)
            val user = if (passwordOk) UserService.findUserByNickname(db, nickname) else null
            if (user == null) {
                RateLimiter.recordFailure(db, RateLimiter.Rules.LOGIN_IP, ip)
                RateLimiter.recordFailure(db, RateLimiter.Rules.LOGIN_USER, userKey)
                call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Invalid credentials"))
                return@post
            }

            // A real server-side session: the token below only names it, and revoking the
            // session (logout, deactivation, ...) ends the access at once.
            val session = SessionService.create(db, user.id)
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

        // A user changes their own password. It is also the one endpoint a user with a temporary
        // password may call (see PasswordChangeGate).
        authenticate("auth-jwt") {
            post("/api/auth/change-password") {
                val user = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                UserService.changeOwnPassword(user, call.receive<ChangePasswordRequest>())
                call.respond(mapOf("status" to "ok"))
            }
        }
    }
}
