package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.domain.SessionUser
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.auth.*

fun Application.projectRoutes() {
    routing {
        authenticate("auth-jwt") {
            route("/api/projects") {
                get {
                    val user = call.principal<SessionUser>() ?: throw cz.stavebni.denik.domain.UnauthenticatedException()
                    val projects = ProjectService.listProjects(DatabaseFactory.dsl, user)
                    call.respond(projects)
                }

                post {
                    val user = call.principal<SessionUser>() ?: throw cz.stavebni.denik.domain.UnauthenticatedException()
                    val req = call.receive<ProjectDto>()
                    val project = ProjectService.createProject(user, req)
                    call.respond(project)
                }
            }
        }
    }
}
