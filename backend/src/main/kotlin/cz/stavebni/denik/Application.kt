package cz.stavebni.denik

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import cz.stavebni.denik.routes.authRoutes
import cz.stavebni.denik.routes.projectRoutes
import cz.stavebni.denik.routes.pdfRoutes
import cz.stavebni.denik.plugins.configureSecurity
import cz.stavebni.denik.plugins.configureStatusPages
import cz.stavebni.denik.db.DatabaseFactory
import kotlinx.serialization.json.Json

fun main(args: Array<String>) = EngineMain.main(args)

fun Application.module() {
    if (!DatabaseFactory.isInitialized) {
        DatabaseFactory.init(
            jdbcUrl = System.getenv("JDBC_URL") ?: System.getProperty("JDBC_URL") ?: "jdbc:postgresql://localhost:5432/stavebni_denik",
            user = System.getenv("DB_USER") ?: System.getProperty("DB_USER") ?: "denik",
            password = System.getenv("DB_PASSWORD") ?: System.getProperty("DB_PASSWORD") ?: "denik_dev"
        )
    }

    install(CORS) {
        anyHost()
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

    configureSecurity()
    configureStatusPages()

    authRoutes()
    projectRoutes()
    pdfRoutes()

    routing {
        get("/api/health") {
            call.respond(mapOf("status" to "ok"))
        }
    }
}
