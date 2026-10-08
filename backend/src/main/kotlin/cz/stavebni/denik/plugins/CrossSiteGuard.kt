package cz.stavebni.denik.plugins

import cz.stavebni.denik.config.AppConfig
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*

/**
 * Refuses state-changing API requests that a browser makes on behalf of *another site*.
 *
 * The session cookie is `SameSite=Lax`, which already keeps it off cross-site POSTs in current browsers,
 * but several endpoints (sign, acknowledge, revoke, the multipart upload) are "simple" requests and
 * the cookie alone should not be the only line of defence. Browsers describe where a request comes from
 * in headers a page cannot forge:
 *
 * 1. `Origin` listed in `CORS_ALLOWED_ORIGINS` (a deliberately separate SPA host): allowed.
 * 2. `Sec-Fetch-Site`: `same-origin` and `none` (typed URL, bookmark) are allowed; `same-site` and
 *    `cross-site` are refused.
 * 3. Older browsers without it send `Origin` on every POST: allowed when its host is the host the
 *    request was addressed to.
 * 4. Neither header: not a browser that can be tricked into a cross-site request (scripts, curl, tests): allowed.
 *
 * Safe methods (GET, HEAD, OPTIONS) are not checked. Every other request is, whatever its path: the router
 * normalises a path (`//api/...`, `/%61pi/...`) before it matches a route, so a check on the raw text of the path
 * can be walked around.
 */
val CrossSiteRequestGuard = createApplicationPlugin("CrossSiteRequestGuard") {
    onCall { call ->
        val request = call.request
        if (request.httpMethod in SAFE_METHODS) return@onCall

        val crossSite = isCrossSite(
            secFetchSite = request.headers["Sec-Fetch-Site"],
            origin = request.headers[HttpHeaders.Origin],
            host = request.headers[HttpHeaders.Host],
            allowedOrigins = AppConfig.corsAllowedOrigins,
        )
        if (crossSite) {
            call.respond(HttpStatusCode.Forbidden, mapOf("error" to "Požadavek z jiného webu byl odmítnut"))
        }
    }
}

private val SAFE_METHODS = setOf(HttpMethod.Get, HttpMethod.Head, HttpMethod.Options)

/** The decision itself, kept free of Ktor types so the rules can be tested one by one. */
internal fun isCrossSite(secFetchSite: String?, origin: String?, host: String?, allowedOrigins: List<String>): Boolean {
    if (origin != null && allowedOrigins.any { it.trimEnd('/').equals(origin.trimEnd('/'), ignoreCase = true) }) return false
    if (secFetchSite != null) return !secFetchSite.trim().lowercase().let { it == "same-origin" || it == "none" }
    if (origin != null) {
        val originHost = origin.substringAfter("://", missingDelimiterValue = "").substringBefore('/')
        return originHost.isEmpty() || host == null || !originHost.equals(host.trim(), ignoreCase = true)
    }
    return false
}
