package cz.stavebni.denik.plugins

import cz.stavebni.denik.config.AppConfig
import io.ktor.server.application.*
import io.ktor.server.plugins.*

/**
 * The address a request comes from, for rate limiting.
 *
 * Taken from the proxy header named in `CLIENT_IP_HEADER` when it is configured, otherwise from the
 * TCP peer. `X-Forwarded-For` is never used: a client can put anything into it. The request body
 * is never consulted either.
 */
fun ApplicationCall.clientIp(): String {
    val configured = AppConfig.clientIpHeader
    val fromProxy = configured?.let { request.headers[it] }?.substringBefore(',')?.trim()
    return (fromProxy?.takeIf { it.isNotEmpty() } ?: request.origin.remoteAddress).take(64)
}
