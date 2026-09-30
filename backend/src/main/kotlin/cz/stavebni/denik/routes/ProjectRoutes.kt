package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.services.AddMemberRequest
import cz.stavebni.denik.services.AuthorizedPersonService
import cz.stavebni.denik.services.CreateAuthorizedPersonRequest
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectMemberService
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.SiteHandoverDto
import cz.stavebni.denik.services.SiteHandoverService
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

private fun ApplicationCall.sessionUser(): SessionUser = principal<SessionUser>() ?: throw UnauthenticatedException()

fun Application.projectRoutes() {
    routing {
        authenticate("auth-jwt") {
            route("/api/projects") {
                get {
                    val user = call.sessionUser()
                    call.respond(ProjectService.listProjects(DatabaseFactory.dsl, user))
                }

                post {
                    val user = call.sessionUser()
                    val req = call.receive<ProjectDto>()
                    call.respond(ProjectService.createProject(user, req))
                }

                route("/{projectId}") {
                    get {
                        val user = call.sessionUser()
                        val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                        call.respond(ProjectService.getProject(DatabaseFactory.dsl, user, projectId))
                    }

                    // --- Project members ---------------------------------------------
                    route("/members") {
                        get {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            call.respond(ProjectMemberService.listMembers(DatabaseFactory.dsl, user, projectId))
                        }
                        post {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            val req = call.receive<AddMemberRequest>()
                            call.respond(ProjectMemberService.addMember(user, projectId, req))
                        }
                        delete("/{userId}") {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            val userId = ProjectAccess.parseId(call.parameters["userId"], "userId")
                            ProjectMemberService.removeMember(user, projectId, userId)
                            call.respond(HttpStatusCode.NoContent)
                        }
                    }

                    // --- Authorized persons (pověřené osoby) --------------------------
                    route("/authorized-persons") {
                        get {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            call.respond(AuthorizedPersonService.list(DatabaseFactory.dsl, user, projectId))
                        }
                        post {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            val req = call.receive<CreateAuthorizedPersonRequest>()
                            call.respond(HttpStatusCode.Created, AuthorizedPersonService.create(user, projectId, req))
                        }
                    }

                    // --- Site handovers (předání stavenitě) -------------------------
                    route("/handovers") {
                        get {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            call.respond(SiteHandoverService.listHandovers(DatabaseFactory.dsl, user, projectId))
                        }
                        post {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            val req = call.receive<SiteHandoverDto>()
                            call.respond(
                                HttpStatusCode.Created,
                                SiteHandoverService.createHandover(user, req.copy(projectId = projectId.toString()))
                            )
                        }
                    }
                }
            }

            post("/api/authorized-persons/{id}/revoke") {
                val user = call.sessionUser()
                val id = ProjectAccess.parseId(call.parameters["id"])
                call.respond(AuthorizedPersonService.revoke(user, id))
            }

            route("/api/handovers/{id}") {
                get {
                    val user = call.sessionUser()
                    val id = ProjectAccess.parseId(call.parameters["id"])
                    val handover = SiteHandoverService.getHandover(DatabaseFactory.dsl, user, id)
                        ?: throw cz.stavebni.denik.domain.NotFoundException("Předávací protokol nenalezen")
                    call.respond(handover)
                }
                put {
                    val user = call.sessionUser()
                    val id = ProjectAccess.parseId(call.parameters["id"])
                    val req = call.receive<SiteHandoverDto>()
                    call.respond(SiteHandoverService.updateHandover(user, id, req))
                }
                delete {
                    val user = call.sessionUser()
                    val id = ProjectAccess.parseId(call.parameters["id"])
                    SiteHandoverService.deleteHandover(user, id)
                    call.respond(HttpStatusCode.NoContent)
                }
                post("/sign") {
                    val user = call.sessionUser()
                    val id = ProjectAccess.parseId(call.parameters["id"])
                    call.respond(SiteHandoverService.signHandover(user, id))
                }
            }
        }
    }
}
