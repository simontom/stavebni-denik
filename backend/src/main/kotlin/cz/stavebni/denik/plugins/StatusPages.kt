package cz.stavebni.denik.plugins

import cz.stavebni.denik.domain.AuditWriteException
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SignerNotQualifiedException
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
import org.slf4j.LoggerFactory

private val statusLog = LoggerFactory.getLogger("cz.stavebni.denik.plugins.StatusPages")

fun Application.configureStatusPages() {
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            // A body that grows past the limit without having announced its size is only noticed while it is being read, and
            // then the JSON reader hands us its own exception with the real one as the cause: still a 413, not a 400.
            if (cause !is PayloadTooLargeException && generateSequence(cause.cause) { it.cause }.take(8).any { it is PayloadTooLargeException }) {
                call.respond(HttpStatusCode.PayloadTooLarge, mapOf("error" to "Požadavek je příliš velký"))
                return@exception
            }
            when (cause) {
                // An audit row that the application could not write is a mistake of the code, not of the client: no conflict, no
                // bad request, nothing internal in the answer. The message holds nothing of the row, so it may go to the log.
                is AuditWriteException -> {
                    statusLog.error("An audit row could not be written and the change was rolled back: ${cause.message}", cause)
                    call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Změnu se nepodařilo zaznamenat, proto nebyla provedena."))
                }
                is UnauthenticatedException -> call.respond(HttpStatusCode.Unauthorized, mapOf("error" to (cause.message ?: "Unauthenticated")))
                // The exception names the denied action for the logs; the client only learns that it is not allowed.
                is ForbiddenException -> call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Nemáte oprávnění k této akci"))
                is SignerNotQualifiedException -> call.respond(HttpStatusCode.Forbidden, mapOf("error" to cause.message, "code" to "SIGNER_NOT_QUALIFIED"))
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
                // Text the database cannot store (a NUL character in a text or in JSON: SQLSTATE 22021, 22P05) is the client's
                // mistake wherever it came from, not an error of the server.
                is org.jooq.exception.DataAccessException ->
                    if (cause.sqlState() in setOf("22021", "22P05")) {
                        call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Text obsahuje nepovolený znak"))
                    } else {
                        cause.printStackTrace()
                        call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Vnitřní chyba serveru"))
                    }
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
