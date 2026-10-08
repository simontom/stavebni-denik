package cz.stavebni.denik

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.http.content.singlePageApplication
import cz.stavebni.denik.config.AppConfig
import cz.stavebni.denik.services.PasswordService
import cz.stavebni.denik.routes.authRoutes
import cz.stavebni.denik.routes.projectRoutes
import cz.stavebni.denik.routes.pdfRoutes
import cz.stavebni.denik.routes.reportRoutes
import cz.stavebni.denik.routes.photoRoutes
import cz.stavebni.denik.routes.userRoutes
import cz.stavebni.denik.routes.auditRoutes
import cz.stavebni.denik.plugins.configureSecurity
import cz.stavebni.denik.plugins.configureStatusPages
import cz.stavebni.denik.db.DatabaseFactory
import kotlinx.serialization.json.Json

fun main(args: Array<String>) = EngineMain.main(args)

fun Application.module() {
    // Before anything touches the database or the network.
    AppConfig.requireReleaseOptIn()

    // Fail at startup, not at the first account creation, if the native Argon2 library cannot run here.
    PasswordService.ensureWorks()

    if (!DatabaseFactory.isInitialized) {
        DatabaseFactory.init(
            jdbcUrl = System.getenv("JDBC_URL") ?: System.getProperty("JDBC_URL") ?: "jdbc:postgresql://localhost:5432/stavebni_denik",
            user = System.getenv("DB_USER") ?: System.getProperty("DB_USER") ?: "denik",
            password = System.getenv("DB_PASSWORD") ?: System.getProperty("DB_PASSWORD") ?: "denik_dev"
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

    install(ContentNegotiation) {
        json(Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        })
    }

    sendPipeline.intercept(ApplicationSendPipeline.Before) { value ->
        if (value is Map<*, *> && value.values.any { it !is String && it !is Number && it !is Boolean && it != null }) {
            val jsonObject = kotlinx.serialization.json.buildJsonObject {
                value.forEach { (k, v) ->
                    val key = k.toString()
                    when (v) {
                        is String -> put(key, kotlinx.serialization.json.JsonPrimitive(v))
                        is Number -> put(key, kotlinx.serialization.json.JsonPrimitive(v))
                        is Boolean -> put(key, kotlinx.serialization.json.JsonPrimitive(v))
                        is cz.stavebni.denik.domain.SessionUser -> put(key, kotlinx.serialization.json.Json.encodeToJsonElement(cz.stavebni.denik.domain.SessionUser.serializer(), v))
                        null -> put(key, kotlinx.serialization.json.JsonNull)
                        else -> put(key, kotlinx.serialization.json.JsonPrimitive(v.toString()))
                    }
                }
            }
            proceedWith(jsonObject)
        }
    }

    configureSecurityHeaders()
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

private const val CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "connect-src 'self' https://api.open-meteo.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

/** Security headers for every response (API and SPA). HSTS only behind HTTPS in production. */
fun Application.configureSecurityHeaders() {
    intercept(ApplicationCallPipeline.Plugins) {
        call.response.header("X-Content-Type-Options", "nosniff")
        call.response.header("X-Frame-Options", "DENY")
        call.response.header("Referrer-Policy", "strict-origin-when-cross-origin")
        call.response.header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        if (AppConfig.isProduction) {
            call.response.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
        }
    }
}
