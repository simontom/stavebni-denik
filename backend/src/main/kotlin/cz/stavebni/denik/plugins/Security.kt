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
import io.ktor.server.response.*

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
                withContext(Dispatchers.IO) {
                    SessionService.resolve(DatabaseFactory.dsl, claims.sessionId, claims.id)
                }
            }

            challenge { defaultScheme, realm ->
                call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Token is not valid or has expired"))
            }
        }
    }
}

data class UserPrincipal(val user: SessionUser) : Principal
