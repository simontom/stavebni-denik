package cz.stavebni.denik.plugins

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*

fun Application.configureStatusPages() {
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            when (cause) {
                is IllegalArgumentException -> call.respond(HttpStatusCode.BadRequest, mapOf("error" to cause.message))
                is IllegalStateException -> call.respond(HttpStatusCode.Conflict, mapOf("error" to cause.message))
                is SecurityException -> call.respond(HttpStatusCode.Forbidden, mapOf("error" to cause.message))
                else -> {
                    cause.printStackTrace()
                    call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Vnitřní chyba serveru"))
                }
            }
        }
    }
}
