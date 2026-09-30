package cz.stavebni.denik.config

import org.slf4j.LoggerFactory
import java.nio.file.Path
import java.nio.file.Paths
import java.security.SecureRandom
import java.util.Base64

/**
 * Runtime configuration read from environment variables (or JVM system
 * properties with the same name, which tests use).
 *
 * | Variable              | Default                     | Notes                                   |
 * |-----------------------|-----------------------------|-----------------------------------------|
 * | APP_ENV               | development                 | `production` enables strict checks      |
 * | JWT_SECRET            | random per process (dev)    | **required** when APP_ENV=production    |
 * | UPLOADS_DIR           | ./uploads                   | photos are stored in `<dir>/photos`     |
 * | CORS_ALLOWED_ORIGINS  | (none → CORS disabled)      | comma separated, e.g. https://a.cz      |
 * | STATIC_DIR            | (none → SPA not served)     | built frontend (Docker image: /app/static) |
 */
object AppConfig {
    private val log = LoggerFactory.getLogger(AppConfig::class.java)

    private fun env(name: String): String? =
        System.getenv(name)?.takeIf { it.isNotBlank() }
            ?: System.getProperty(name)?.takeIf { it.isNotBlank() }

    val isProduction: Boolean
        get() = env("APP_ENV")?.lowercase() == "production"

    /**
     * HMAC secret for session JWTs. Outside production a random secret is
     * generated per process (sessions do not survive a restart) so that no
     * well-known default secret exists in the code base.
     */
    val jwtSecret: String by lazy {
        env("JWT_SECRET") ?: run {
            check(!isProduction) { "JWT_SECRET must be set when APP_ENV=production" }
            log.warn("JWT_SECRET is not set - using a random per-process secret (development only)")
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            Base64.getEncoder().encodeToString(bytes)
        }
    }

    val uploadsDir: Path
        get() = Paths.get(env("UPLOADS_DIR") ?: "uploads")

    /** Directory with the built SPA (`frontend/dist`); served by Ktor when set. */
    val staticDir: String?
        get() = env("STATIC_DIR")

    val corsAllowedOrigins: List<String>
        get() = env("CORS_ALLOWED_ORIGINS")
            ?.split(",")
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()
}
