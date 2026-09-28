package cz.stavebni.denik

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import cz.stavebni.denik.db.DatabaseFactory
import kotlinx.serialization.json.Json

fun main(args: Array<String>) = EngineMain.main(args)

fun Application.module() {
    DatabaseFactory.init(
        jdbcUrl = System.getenv("JDBC_URL") ?: "jdbc:postgresql://localhost:5432/stavebni_denik",
        user = System.getenv("DB_USER") ?: "denik",
        password = System.getenv("DB_PASSWORD") ?: "denik_dev"
    )

    install(ContentNegotiation) {
        json(Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        })
    }

    routing {
        get("/api/health") {
            call.respond(mapOf("status" to "ok"))
        }
    }
}
