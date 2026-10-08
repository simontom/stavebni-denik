package cz.stavebni.denik.plugins

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.services.JwtService
import cz.stavebni.denik.services.SessionService
import cz.stavebni.denik.domain.SessionUser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import io.ktor.server.auth.Principal
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.auth.jwt.*
import io.ktor.server.request.path
import io.ktor.server.response.*
import io.ktor.util.AttributeKey

fun Application.configureSecurity() {
    val secret = cz.stavebni.denik.config.AppConfig.jwtSecret
    val issuer = "stavebni_denik"
    val algorithm = Algorithm.HMAC256(secret)

    install(Authentication) {
        jwt("auth-jwt") {
            verifier(
                JWT.require(algorithm)
                    .withIssuer(issuer)
                    .build()
            )
            
            authHeader { call ->
                // Look for the token in the HttpOnly cookie first
                val cookie = call.request.cookies["jwt"]
                if (cookie != null) {
                    try {
                        io.ktor.http.auth.parseAuthorizationHeader("Bearer $cookie")
                    } catch (e: Exception) {
                        null
                    }
                } else {
                    // Fallback to standard Authorization header
                    call.request.parseAuthorizationHeader()
                }
            }

            validate { credential ->
                // The token only names a session and a user. Whether the session is still valid,
                // and what the user may do now, is decided by the database on every request.
                val claims = JwtService.decodeUser(credential.payload) ?: return@validate null
                val user = withContext(Dispatchers.IO) {
                    SessionService.resolve(DatabaseFactory.dsl, claims.sessionId, claims.id)
                } ?: return@validate null

                // A temporary password (new account, administrator reset) confines the user to changing it.
                // Without this, whoever handed out the password could keep acting as that user, including
                // signing reports in their name. Refusing here covers every protected route at once.
                if (user.mustChangePwd && request.path() != CHANGE_PASSWORD_PATH) {
                    attributes.put(PasswordChangeRequired, true)
                    return@validate null
                }
                user
            }

            challenge { _, _ ->
                if (call.attributes.getOrNull(PasswordChangeRequired) == true) {
                    call.respond(
                        HttpStatusCode.Forbidden,
                        mapOf("error" to "Před dalším použitím aplikace je nutné změnit heslo", "code" to PASSWORD_CHANGE_REQUIRED)
                    )
                } else {
                    call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Token is not valid or has expired"))
                }
            }
        }
    }
}

/** Machine-readable reason the SPA reacts to by showing the change-password form. */
const val PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"

/** The only authenticated endpoint a user may call while their password is temporary. */
private const val CHANGE_PASSWORD_PATH = "/api/auth/change-password"

/** Set by token validation when the session is fine but the password is temporary, so the challenge answers 403 instead of 401. */
private val PasswordChangeRequired = AttributeKey<Boolean>("PasswordChangeRequired")

data class UserPrincipal(val user: SessionUser) : Principal
