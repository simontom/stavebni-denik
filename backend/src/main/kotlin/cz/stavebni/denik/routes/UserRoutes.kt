package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.services.CreateUserRequest
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.services.UpdateUserRequest
import cz.stavebni.denik.services.UserService
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

/** User administration (app admins) and user pickers (project managers). */
fun Application.userRoutes() {
    routing {
        authenticate("auth-jwt") {
            route("/api/users") {
                get {
                    val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    call.respond(UserService.listUsers(DatabaseFactory.dsl, actor))
                }

                post {
                    val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    val req = call.receive<CreateUserRequest>()
                    call.respond(HttpStatusCode.Created, UserService.createUser(actor, req))
                }

                get("/options") {
                    val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                    call.respond(UserService.listUserOptions(DatabaseFactory.dsl, actor))
                }

                route("/{id}") {
                    patch {
                        val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val id = ProjectAccess.parseId(call.parameters["id"])
                        val req = call.receive<UpdateUserRequest>()
                        call.respond(UserService.updateUser(actor, id, req))
                    }

                    delete {
                        val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val id = ProjectAccess.parseId(call.parameters["id"])
                        UserService.deleteUser(actor, id)
                        call.respond(HttpStatusCode.NoContent)
                    }

                    post("/activate") {
                        val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val id = ProjectAccess.parseId(call.parameters["id"])
                        call.respond(UserService.setActive(actor, id, active = true))
                    }

                    post("/deactivate") {
                        val actor = call.principal<SessionUser>() ?: throw UnauthenticatedException()
                        val id = ProjectAccess.parseId(call.parameters["id"])
                        call.respond(UserService.setActive(actor, id, active = false))
                    }
                }
            }
        }
    }
}
