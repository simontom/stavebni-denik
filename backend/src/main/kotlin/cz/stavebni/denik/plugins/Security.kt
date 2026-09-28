package cz.stavebni.denik.plugins

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import cz.stavebni.denik.services.JwtService
import cz.stavebni.denik.domain.SessionUser
import io.ktor.server.auth.Principal
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.auth.jwt.*
import io.ktor.server.response.*

fun Application.configureSecurity() {
    val secret = System.getenv("JWT_SECRET") ?: "dev_secret_key_123"
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
                val jwt = credential.payload
                val user = JwtService.decodeUser(jwt)
                user
            }

            challenge { defaultScheme, realm ->
                call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Token is not valid or has expired"))
            }
        }
    }
}

data class UserPrincipal(val user: SessionUser) : Principal
