package cz.stavebni.denik.plugins

import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.UnauthenticatedException
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*

fun Application.configureStatusPages() {
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            when (cause) {
                is UnauthenticatedException -> call.respond(HttpStatusCode.Unauthorized, mapOf("error" to (cause.message ?: "Unauthenticated")))
                is ForbiddenException -> call.respond(HttpStatusCode.Forbidden, mapOf("error" to (cause.message ?: "Forbidden")))
                is NotFoundException -> call.respond(HttpStatusCode.NotFound, mapOf("error" to (cause.message ?: "Not found")))
                is SecurityException -> call.respond(HttpStatusCode.Forbidden, mapOf("error" to cause.message))
                is IllegalArgumentException -> call.respond(HttpStatusCode.BadRequest, mapOf("error" to cause.message))
                is IllegalStateException -> call.respond(HttpStatusCode.Conflict, mapOf("error" to cause.message))
                else -> {
                    cause.printStackTrace()
                    call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Vnitřní chyba serveru"))
                }
            }
        }
    }
}
