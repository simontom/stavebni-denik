package cz.stavebni.denik.plugins

import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.StaleVersionException
import cz.stavebni.denik.domain.TooManyRequestsException
import cz.stavebni.denik.domain.UnauthenticatedException
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.ContentTransformationException
import io.ktor.server.plugins.PayloadTooLargeException
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import kotlinx.serialization.SerializationException
import org.jooq.exception.IntegrityConstraintViolationException

fun Application.configureStatusPages() {
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            when (cause) {
                is UnauthenticatedException -> call.respond(HttpStatusCode.Unauthorized, mapOf("error" to (cause.message ?: "Unauthenticated")))
                // The exception names the denied action for the logs; the client only learns that it is not allowed.
                is ForbiddenException -> call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Nemáte oprávnění k této akci"))
                is NotFoundException -> call.respond(HttpStatusCode.NotFound, mapOf("error" to (cause.message ?: "Not found")))
                is TooManyRequestsException -> {
                    call.response.header(HttpHeaders.RetryAfter, cause.retryAfterSeconds.toString())
                    call.respond(HttpStatusCode.TooManyRequests, mapOf("error" to cause.message))
                }
                is StaleVersionException ->
                    call.respond(HttpStatusCode.Conflict, mapOf("error" to cause.message, "code" to "STALE_VERSION"))
                is ConflictException -> call.respond(HttpStatusCode.Conflict, mapOf("error" to (cause.message ?: "Conflict")))
                is PayloadTooLargeException -> call.respond(HttpStatusCode.PayloadTooLarge, mapOf("error" to "Požadavek je příliš velký"))
                is SecurityException -> call.respond(HttpStatusCode.Forbidden, mapOf("error" to cause.message))
                // A body that is missing, is not JSON or does not fit the expected shape is the client's mistake.
                is BadRequestException, is ContentTransformationException, is SerializationException ->
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Neplatný obsah požadavku"))
                // For example two requests creating the same day at once: the database refuses the second.
                is IntegrityConstraintViolationException ->
                    call.respond(HttpStatusCode.Conflict, mapOf("error" to "Záznam již existuje nebo odporuje omezením"))
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
