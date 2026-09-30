package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
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
        }
    }
}
