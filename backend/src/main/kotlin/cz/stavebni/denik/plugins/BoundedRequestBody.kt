package cz.stavebni.denik.plugins

import io.ktor.server.application.*
import io.ktor.server.plugins.*
import io.ktor.server.request.*
import io.ktor.utils.io.*
import io.ktor.utils.io.pool.*
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.GlobalScope

/** The limit of [BoundedRequestBody], decided per call. [Long.MAX_VALUE] means unlimited. */
class BoundedRequestBodyConfig {
    internal var bodyLimit: (ApplicationCall) -> Long = { Long.MAX_VALUE }

    fun bodyLimit(block: (ApplicationCall) -> Long) {
        bodyLimit = block
    }
}

/**
 * Limits the size of a request body: `413` when `Content-Length` announces more, and when a body without it (or lying about
 * it) delivers more. It is Ktor's `RequestBodyLimit` with **one difference that matters**: the copy of the body that it
 * makes is flushed as it goes ([applyLimit]).
 *
 * Ktor's own plugin writes into a channel that is flushed only when 1 MiB has piled up or the body has ended. Everything
 * behind it, the multipart parser included, then sees nothing of a request until its first mebibyte (or its end) has arrived:
 * a handler cannot look at the fields at the start of an upload, and cannot tell a client that has stopped sending from one
 * that is slow. Measured on Ktor 3.6.0: 1,048,000 bytes sent and then silence reach the handler never, 1,100,000 do.
 */
val BoundedRequestBody = createApplicationPlugin("BoundedRequestBody", ::BoundedRequestBodyConfig) {
    val bodyLimit = pluginConfig.bodyLimit

    // The Validators phase, like Ktor's own plugin, and not `onCall` (the Plugins phase): there the refusal came before the
    // interceptor that sets the security headers had run, so the 413 had none of them, and the headers interceptor then
    // failed on a response that was already sent and logged an error for every such request.
    onCallValidators { call ->
        val limit = bodyLimit(call)
        val contentLength = call.request.contentLength()
        if (contentLength != null && contentLength > limit) throw PayloadTooLargeException(limit)
    }

    application.receivePipeline.intercept(ApplicationReceivePipeline.Before) { body ->
        val limit = bodyLimit(call)
        if (limit != Long.MAX_VALUE && body is ByteReadChannel) proceedWith(body.applyLimit(limit))
    }
}

@OptIn(DelicateCoroutinesApi::class)
internal fun ByteReadChannel.applyLimit(limit: Long): ByteReadChannel {
    if (isClosedForRead) return this
    return GlobalScope.writer(autoFlush = true) {
        var total = 0L
        ByteArrayPool.useInstance { array ->
            while (!isClosedForRead) {
                val read = readAvailable(array, 0, array.size)
                if (read <= 0) continue
                channel.writeFully(array, 0, read)
                total += read
                if (total > limit) throw PayloadTooLargeException(limit)
            }
            closedCause?.let { throw it }
        }
    }.channel
}
