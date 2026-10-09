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
            val ip = RateLimiter.addressKey(call.clientIp())
            val userKey = UserService.loginKey(nickname)

            // The attempt is reserved first: too many failures from this address (an IPv6 client counts as its /64) or
            // against this name refuse the request before any password work is done. A reservation stays on record
            // unless the login succeeds, so requests that arrive at the same moment cannot all slip under the limit.
            val reservation = RateLimiter.reserve(
                db,
                listOf(RateLimiter.Rules.LOGIN_IP to ip, RateLimiter.Rules.LOGIN_USER to userKey),
            )
            reservation.refusedFor?.let { wait ->
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
                call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Invalid credentials"))
                return@post
            }

            // A real server-side session: the token below only names it, and revoking the session (logout,
            // deactivation, ...) ends the access at once. It is opened only if this is still the user's password.
            val session = when (val opened = SessionService.openAfterPasswordCheck(db, user.id, hash!!)) {
                is SessionService.Opened.Session -> opened.created
                SessionService.Opened.CredentialsChanged -> {
                    call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Invalid credentials"))
                    return@post
                }
                SessionService.Opened.PasswordExpired -> {
                    // Only a correct password gets here, so saying so reveals nothing to someone who does not have it.
                    call.respond(
                        HttpStatusCode.Unauthorized,
                        mapOf("error" to "Dočasné heslo vypršelo. Požádejte správce o nové.", "code" to "PASSWORD_EXPIRED")
                    )
                    return@post
                }
            }
            // The password was right: this attempt was not a failure.
            RateLimiter.release(db, reservation)
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
