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
     * Deliberate opt-in for running this build with `APP_ENV=production`.
     *
     * The application is not released for real diary data yet (PROJECT.md,
     * "Release gate"). Until then a production machine must not start it by
     * accident; the guard is removed together with the last release-gate item.
     */
    val allowUnreleasedBuild: Boolean
        get() = env("ALLOW_UNRELEASED_BUILD")?.lowercase() == "true"

    /** Fails startup in production mode unless [allowUnreleasedBuild] is set. */
    fun requireReleaseOptIn() {
        if (!isProduction) return
        check(allowUnreleasedBuild) {
            "This build is not released for production use yet (see PROJECT.md, \"Release gate\"). " +
                "To start it anyway on a machine that only holds test data, set ALLOW_UNRELEASED_BUILD=true."
        }
        log.warn("ALLOW_UNRELEASED_BUILD=true: running an unreleased build in production mode - use test data only")
    }

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

    /**
     * Name of a request header that a trusted reverse proxy sets to the real client address
     * (`Fly-Client-IP` on Fly.io). Only set it when *every* request passes through that proxy,
     * which overwrites the header: otherwise a client could invent its own address and escape
     * the per-address login limit. Unset, the address of the TCP peer is used.
     */
    val clientIpHeader: String?
        get() = env("CLIENT_IP_HEADER")

    /**
     * Range endpoint of the Pwned Passwords service used to refuse passwords from known breaches
     * (`PWNED_PASSWORDS_URL`; `off` or `none` disables it). Unset: on in production, off elsewhere, so
     * development and tests never call out to the internet.
     */
    val pwnedPasswordsUrl: String?
        get() = when (val value = env("PWNED_PASSWORDS_URL")) {
            null -> if (isProduction) "https://api.pwnedpasswords.com/range" else null
            else -> value.takeUnless { it.equals("off", ignoreCase = true) || it.equals("none", ignoreCase = true) }
        }

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
