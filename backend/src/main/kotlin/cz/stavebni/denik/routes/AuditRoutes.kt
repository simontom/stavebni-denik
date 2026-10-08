package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.services.AuditAnchor
import cz.stavebni.denik.services.AuditLogService
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Application.auditRoutes() {
    routing {
        authenticate("auth-jwt") {
            get("/api/audit") {
                val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 200
                call.respond(AuditLogService.list(DatabaseFactory.dsl, actor, limit))
            }

            // Recomputes the whole hash chain (tamper evidence). With `?anchor=<id>:<rowHash>`, a head recorded
            // earlier outside the database, it also proves that nothing up to that row was removed or rewritten.
            get("/api/audit/verify") {
                val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                val anchor = call.request.queryParameters["anchor"]?.let {
                    AuditAnchor.parse(it) ?: throw IllegalArgumentException("Neplatná kotva, očekává se <id>:<hash>")
                }
                call.respond(AuditLogService.verify(DatabaseFactory.dsl, actor, anchor))
            }
        }
    }
}
