package cz.stavebni.denik

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.http.content.singlePageApplication
import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.domain.AppJson
import cz.stavebni.denik.services.PasswordService
import cz.stavebni.denik.routes.authRoutes
import cz.stavebni.denik.routes.projectRoutes
import cz.stavebni.denik.routes.pdfRoutes
import cz.stavebni.denik.routes.reportRoutes
import cz.stavebni.denik.routes.photoRoutes
import cz.stavebni.denik.routes.userRoutes
import cz.stavebni.denik.routes.auditRoutes
import cz.stavebni.denik.plugins.BoundedRequestBody
import cz.stavebni.denik.plugins.CrossSiteRequestGuard
import cz.stavebni.denik.plugins.configureSecurity
import cz.stavebni.denik.plugins.configureRequestContext
import cz.stavebni.denik.plugins.configureStatusPages
import cz.stavebni.denik.db.DatabaseFactory

fun main(args: Array<String>) = EngineMain.main(args)

private const val JSON_BODY_LIMIT_BYTES = 256L * 1024
const val UPLOAD_BODY_LIMIT_BYTES = 6L * 1024 * 1024

fun Application.module() {
    // Before anything touches the database or the network.
    AppConfig.requireReleaseOptIn()

    // Fail at startup, not at the first account creation, if the native Argon2 library cannot run here.
    PasswordService.ensureWorks()

    if (!DatabaseFactory.isInitialized) {
        DatabaseFactory.init(
            jdbcUrl = System.getenv("JDBC_URL") ?: System.getProperty("JDBC_URL") ?: "jdbc:postgresql://localhost:5432/stavebni_denik",
            user = System.getenv("DB_USER") ?: System.getProperty("DB_USER") ?: "denik",
            password = System.getenv("DB_PASSWORD") ?: System.getProperty("DB_PASSWORD") ?: "denik_dev",
            migrate = AppConfig.migrateOnStart,
            // Without migrating, an old schema must stop the start, not break the first request that needs a new column.
            requireCurrent = true,
        )
    }

    // The SPA is served same-origin (Vite proxy in dev), so CORS is only
    // enabled for explicitly configured origins - never for any host.
    val corsOrigins = AppConfig.corsAllowedOrigins
    if (corsOrigins.isNotEmpty()) install(CORS) {
        corsOrigins.forEach { origin ->
            val scheme = origin.substringBefore("://", "https")
            allowHost(origin.substringAfter("://"), schemes = listOf(scheme))
        }
        allowHeader(HttpHeaders.ContentType)
        allowHeader(HttpHeaders.Authorization)
        allowHeader(HttpHeaders.Cookie)
        allowMethod(HttpMethod.Options)
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Put)
        allowMethod(HttpMethod.Patch)
        allowMethod(HttpMethod.Delete)
        allowCredentials = true
        exposeHeader(HttpHeaders.SetCookie)
    }

    // Before any route runs: a state-changing request that another site makes through the user's browser is refused.
    install(CrossSiteRequestGuard)

    // Nothing may make the server buffer an unbounded request body, not even before login. JSON
    // requests are small; a photo upload carries one file of at most 5 MB plus multipart framing.
    // (Not Ktor's RequestBodyLimit: that one holds back what it copies until 1 MiB has piled up, see BoundedRequestBody.)
    install(BoundedRequestBody) {
        bodyLimit { call -> if (call.request.path() == "/api/photos/upload") UPLOAD_BODY_LIMIT_BYTES else JSON_BODY_LIMIT_BYTES }
    }

    install(ContentNegotiation) {
        json(AppJson.api)
    }

    configureSecurityHeaders()
    configureRequestContext()
    configureSecurity()
    configureStatusPages()

    authRoutes()
    projectRoutes()
    pdfRoutes()
    reportRoutes()
    photoRoutes()
    userRoutes()
    auditRoutes()

    routing {
        get("/api/health") {
            call.respond(mapOf("status" to "ok"))
        }
    }

    // Production image: the built React SPA is served by Ktor from the same origin.
    AppConfig.staticDir?.let { dir ->
        routing {
            singlePageApplication {
                filesPath = dir
                defaultPage = "index.html"
            }
        }
    }
}

/** A page talks to its own origin only: the weather is typed by hand, nothing calls an external API. */
private const val CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

/** Device features the application never uses. `camera=()` governs getUserMedia only: the photo field is a plain file input. */
private const val PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()"

/**
 * Security headers for every response (API and SPA). HSTS only behind HTTPS in production.
 *
 * `Cross-Origin-Resource-Policy` is `same-site`, not `same-origin`: photos have to stay loadable from an SPA host
 * listed in `CORS_ALLOWED_ORIGINS`.
 */
fun Application.configureSecurityHeaders() {
    intercept(ApplicationCallPipeline.Plugins) {
        call.response.header("X-Content-Type-Options", "nosniff")
        call.response.header("X-Frame-Options", "DENY")
        call.response.header("Referrer-Policy", "strict-origin-when-cross-origin")
        call.response.header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        call.response.header("Permissions-Policy", PERMISSIONS_POLICY)
        call.response.header("Cross-Origin-Opener-Policy", "same-origin")
        call.response.header("Cross-Origin-Resource-Policy", "same-site")
        if (AppConfig.isProduction) {
            call.response.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
        }
    }
}
