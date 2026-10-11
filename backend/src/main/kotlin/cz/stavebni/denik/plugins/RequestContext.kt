package cz.stavebni.denik.plugins

import io.ktor.http.*
import io.ktor.server.application.*
import kotlinx.coroutines.withContext
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/**
 * Where the request being handled came from. It travels with the coroutine, so the audit log can record it without
 * every service having to be handed the call.
 *
 * It is personal data, so it is never part of the audit hash: [cz.stavebni.denik.services.AuditService] writes it to a
 * side table that is deleted after twelve months (decision D7, see PROJECT.md "Audit log").
 */
class RequestContext(val ip: String, val userAgent: String?) : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<RequestContext>
}

private const val MAX_USER_AGENT_LENGTH = 256

/**
 * The user agent as it is stored: a header an attacker controls, so it is bounded and stripped of control characters
 * (the database refuses some of them in text, and a refused insert would abort the request's whole audit transaction).
 */
fun ApplicationCall.userAgent(): String? =
    request.headers[HttpHeaders.UserAgent]
        ?.filter { it >= ' ' && it != '\u007f' }
        ?.take(MAX_USER_AGENT_LENGTH)
        ?.takeIf { it.isNotBlank() }

/** Puts a [RequestContext] on the coroutine of every call. */
fun Application.configureRequestContext() {
    intercept(ApplicationCallPipeline.Plugins) {
        withContext(RequestContext(call.clientIp(), call.userAgent())) { proceed() }
    }
}
