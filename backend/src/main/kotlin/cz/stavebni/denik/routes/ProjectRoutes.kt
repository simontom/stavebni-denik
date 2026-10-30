package cz.stavebni.denik.routes

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.AppJson
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.HandoverSide
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.services.AddMemberRequest
import cz.stavebni.denik.services.AuthorizedPersonService
import cz.stavebni.denik.services.CreateAuthorizedPersonRequest
import cz.stavebni.denik.services.ProjectAccess
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectMemberService
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.SignHandoverRequest
import cz.stavebni.denik.services.SigningGuard
import cz.stavebni.denik.services.SiteHandoverInput
import cz.stavebni.denik.services.SiteHandoverService
import cz.stavebni.denik.services.SiteManagerChangeRequest
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

private fun ApplicationCall.sessionUser(): SessionUser = principal<SessionUser>() ?: throw UnauthenticatedException()

/**
 * The body of a request to sign a handover protocol: the side (optional, it follows from the role), the signer's password
 * (required: signing asks for it again, decision D8) and the version of the protocol the signer was looking at (required).
 */
@Serializable
private data class SignHandoverPayload(val side: String? = null, val password: String? = null, val expectedUpdatedAt: String? = null)

private class HandoverSignRequest(val side: HandoverSide?, val password: String?, val expectedUpdatedAt: OffsetDateTime)

/** The body of a sign request, as it was sent. A body that is not valid JSON is a 400, like everywhere else; nothing else is judged here. */
private suspend fun ApplicationCall.receiveHandoverSignPayload(): SignHandoverPayload {
    val text = receiveText()
    return if (text.isBlank()) SignHandoverPayload() else AppJson.lenient.decodeFromString(SignHandoverPayload.serializer(), text)
}

/**
 * What the body asks for, judged once the person is known to be allowed to sign: a side that is not [own] is refused (403), a side
 * that does not exist and a missing or unreadable version are a 400. The version is required: a signature covers a version.
 */
private fun SignHandoverPayload.toRequest(own: HandoverSide): HandoverSignRequest {
    val side = side?.takeIf { it.isNotBlank() }?.let { name ->
        HandoverSide.entries.firstOrNull { it.name == name } ?: throw IllegalArgumentException("Neplatná strana podpisu (CONTRACTOR nebo CLIENT)")
    }
    if (side != null && side != own) throw ForbiddenException(Action.SiteHandoverSign)
    val version = expectedUpdatedAt?.takeIf { it.isNotBlank() }
        ?: throw IllegalArgumentException("Chybí verze protokolu (expectedUpdatedAt): načtěte protokol znovu a podepište jej z něj")
    val expected = try {
        OffsetDateTime.parse(version)
    } catch (e: DateTimeParseException) {
        throw IllegalArgumentException("Neplatná hodnota expectedUpdatedAt")
    }
    return HandoverSignRequest(side, password, expected)
}

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

                    // The manager of the project changes what is entered about it; the audit row keeps both versions.
                    put {
                        val user = call.sessionUser()
                        val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                        val req = call.receive<ProjectDto>()
                        call.respond(ProjectService.updateProject(user, projectId, req))
                    }

                    // The manager of the project replaces its site manager; the audit row names both persons and the reason.
                    put("/site-manager") {
                        val user = call.sessionUser()
                        val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                        val req = call.receive<SiteManagerChangeRequest>()
                        call.respond(ProjectService.changeSiteManager(user, projectId, req))
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

                    // --- Site handovers (předání staveniště) -------------------------
                    route("/handovers") {
                        get {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            call.respond(SiteHandoverService.listHandovers(DatabaseFactory.dsl, user, projectId))
                        }
                        post {
                            val user = call.sessionUser()
                            val projectId = ProjectAccess.parseId(call.parameters["projectId"], "projectId")
                            val req = call.receive<SiteHandoverInput>()
                            call.respond(HttpStatusCode.Created, SiteHandoverService.createHandover(user, projectId, req))
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
                    val req = call.receive<SiteHandoverInput>()
                    call.respond(SiteHandoverService.updateHandover(user, id, req))
                }
                delete {
                    val user = call.sessionUser()
                    val id = ProjectAccess.parseId(call.parameters["id"])
                    SiteHandoverService.deleteHandover(user, id)
                    call.respond(HttpStatusCode.NoContent)
                }
                // One signature for each side. First whether this person may sign this protocol at all (so that somebody who cannot is
                // told so, whatever the body says, and is not asked for a password), then what the body asks for, then the password, then
                // the signature in one transaction with the audit row.
                post("/sign") {
                    val user = call.sessionUser()
                    val id = ProjectAccess.parseId(call.parameters["id"])
                    val payload = call.receiveHandoverSignPayload()
                    val own = SiteHandoverService.checkMaySign(user, id, null)
                    val request = payload.toRequest(own)
                    SigningGuard.confirmPassword(user, request.password)
                    call.respond(SiteHandoverService.signHandover(user, id, SignHandoverRequest(request.side, request.expectedUpdatedAt)))
                }
            }
        }
    }
}
