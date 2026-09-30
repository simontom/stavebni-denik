package cz.stavebni.denik.services

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import com.auth0.jwt.interfaces.DecodedJWT
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.Role
import java.time.Instant
import java.util.Date
import java.util.UUID

object JwtService {
    private val issuer = "stavebni_denik"
    private val algorithm by lazy { Algorithm.HMAC256(cz.stavebni.denik.config.AppConfig.jwtSecret) }

    fun createToken(user: SessionUser, expiration: Instant): String {
        return JWT.create()
            .withIssuer(issuer)
            .withClaim("id", user.id.toString())
            .withClaim("nickname", user.nickname)
            .withClaim("displayName", user.displayName)
            .withClaim("role", user.role.name)
            .withClaim("isAdmin", user.isAdmin)
            .withClaim("mustChangePwd", user.mustChangePwd)
            .withClaim("sessionId", user.sessionId.toString())
            .withExpiresAt(Date.from(expiration))
            .withIssuedAt(Date.from(Instant.now()))
            .sign(algorithm)
    }

    fun verify(token: String): DecodedJWT? {
        return try {
            val verifier = JWT.require(algorithm)
                .withIssuer(issuer)
                .build()
            verifier.verify(token)
        } catch (e: Exception) {
            null
        }
    }

    fun decodeUser(jwt: com.auth0.jwt.interfaces.Payload): SessionUser? {
        return try {
            SessionUser(
                id = UUID.fromString(jwt.getClaim("id").asString()),
                nickname = jwt.getClaim("nickname").asString(),
                displayName = jwt.getClaim("displayName").asString(),
                role = Role.valueOf(jwt.getClaim("role").asString()),
                isAdmin = jwt.getClaim("isAdmin").asBoolean(),
                mustChangePwd = jwt.getClaim("mustChangePwd").asBoolean(),
                sessionId = UUID.fromString(jwt.getClaim("sessionId").asString())
            )
        } catch (e: Exception) {
            null
        }
    }
}

