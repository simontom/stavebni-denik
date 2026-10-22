package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVER_SIGNATURES
import cz.stavebni.denik.module
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import cz.stavebni.denik.services.SiteHandoverDto
import cz.stavebni.denik.services.SiteHandoverState
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** The HTTP side of two-party signing of a site handover (backlog A3): who is told what, in which order, with which code. */
class SiteHandoverRoutesTest : BaseIntegrationTest() {

    private val password = "Password123!"
    private val json = Json { ignoreUnknownKeys = true }

    private class Site(
        val projectId: UUID,
        val boss: SessionUser,
        val worker: SessionUser,
        val investor: SessionUser,
        val inspector: SessionUser,
        val admin: SessionUser,
        val outsider: SessionUser,
    )

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS, displayName = "Ing. Karel Dvořák")
        val worker = createTestUser(role = Role.WORKER)
        val investor = createTestUser(role = Role.INVESTOR, displayName = "Marie Stavebníková")
        val inspector = createTestUser(role = Role.INSPECTOR)
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val outsider = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Handover Routes", address = "Address", cadastralArea = "Area", parcelNumbers = "1",
                builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        listOf(worker, investor, inspector).forEach { addMember(projectId, it) }
        return Site(projectId, boss, worker, investor, inspector, admin, outsider)
    }

    private suspend fun ApplicationTestBuilder.send(method: HttpMethod, path: String, user: SessionUser, body: String? = null): HttpResponse =
        client.request(path) {
            this.method = method
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }

    private suspend fun HttpResponse.error(): String = runCatching { Json.parseToJsonElement(bodyAsText()).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull().orEmpty()

    private suspend fun HttpResponse.obj(): JsonObject = Json.parseToJsonElement(bodyAsText()).jsonObject

    private suspend fun HttpResponse.handover(): SiteHandoverDto = json.decodeFromString(SiteHandoverDto.serializer(), bodyAsText())

    private fun create(type: String = "Předání staveniště zhotoviteli") =
        """{"type":"$type","date":"2026-09-11","participants":"Novák, Svoboda","meterStates":[{"medium":"Elektřina VT","serialNumber":"EL-98765","state":"12450 kWh"}],"notes":"Bez výhrad"}"""

    private suspend fun ApplicationTestBuilder.made(site: Site, user: SessionUser = site.boss): SiteHandoverDto {
        val response = send(HttpMethod.Post, "/api/projects/${site.projectId}/handovers", user, create())
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        return response.handover()
    }

    private fun signBody(handover: SiteHandoverDto, password: String? = this.password, side: String? = null, version: String? = handover.updatedAt): String {
        val fields = listOfNotNull(
            password?.let { """"password":"$it"""" },
            side?.let { """"side":"$it"""" },
            version?.let { """"expectedUpdatedAt":"$it"""" },
        )
        return "{${fields.joinToString(",")}}"
    }

    @Test
    fun `a handover is made, changed and signed by both parties over HTTP`() = testApplication {
        application { module() }
        val s = site()

        val handover = made(s)
        assertEquals(SiteHandoverState.DRAFT, handover.state)
        assertNotNull(handover.updatedAt)

        // A change names the version it is based on.
        val changed = send(
            HttpMethod.Put, "/api/handovers/${handover.id}", s.boss,
            """{"type":"Předání","date":"2026-09-12","participants":"Novák","notes":"Opraveno","expectedUpdatedAt":"${handover.updatedAt}"}""",
        )
        assertEquals(HttpStatusCode.OK, changed.status, changed.bodyAsText())
        val current = changed.handover()
        assertEquals("Opraveno", current.notes)
        assertNotEquals(handover.updatedAt, current.updatedAt)

        // The manager signs for the contractor.
        val byContractor = send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.boss, signBody(current))
        assertEquals(HttpStatusCode.OK, byContractor.status, byContractor.bodyAsText())
        val half = byContractor.handover()
        assertEquals(SiteHandoverState.SIGNED_BY_CONTRACTOR, half.state)
        assertEquals("Ing. Karel Dvořák", half.contractorSignature!!.signerName)
        assertEquals(current.updatedAt, half.updatedAt)

        // From then on it cannot be changed or deleted by anybody.
        val late = send(
            HttpMethod.Put, "/api/handovers/${handover.id}", s.boss,
            """{"type":"Předání","date":"2026-09-12","participants":"Novák","notes":"Pozdě","expectedUpdatedAt":"${half.updatedAt}"}""",
        )
        assertEquals(HttpStatusCode.Conflict, late.status)
        assertEquals(HttpStatusCode.Conflict, send(HttpMethod.Delete, "/api/handovers/${handover.id}", s.boss).status)

        // The investor signs for the client with the version they looked at, which the manager's signature did not move.
        val byClient = send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.investor, signBody(current))
        assertEquals(HttpStatusCode.OK, byClient.status, byClient.bodyAsText())
        val complete = byClient.handover()
        assertEquals(SiteHandoverState.COMPLETE, complete.state)
        assertEquals(half.contractorSignature, complete.contractorSignature)
        assertEquals("Marie Stavebníková", complete.clientSignature!!.signerName)

        val read = send(HttpMethod.Get, "/api/handovers/${handover.id}", s.inspector).handover()
        assertEquals(complete, read)
        assertEquals(listOf(complete), json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(SiteHandoverDto.serializer()), send(HttpMethod.Get, "/api/projects/${s.projectId}/handovers", s.worker).bodyAsText()))
    }

    @Test
    fun `the request has to name the version, and a protocol that changed since is a 409 STALE_VERSION`() = testApplication {
        application { module() }
        val s = site()
        val handover = made(s)

        val without = send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.boss, signBody(handover, version = null))
        assertEquals(HttpStatusCode.BadRequest, without.status)
        assertTrue(without.error().contains("expectedUpdatedAt"), without.error())
        assertEquals(HttpStatusCode.BadRequest, send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.boss, signBody(handover, version = "včera")).status)
        assertEquals(HttpStatusCode.BadRequest, send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.boss, "").status)
        assertEquals(HttpStatusCode.BadRequest, send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.boss, "{not json").status)
        assertEquals(HttpStatusCode.BadRequest, send(
            HttpMethod.Put, "/api/handovers/${handover.id}", s.boss, """{"type":"X","date":"2026-09-12","participants":"N"}""",
        ).status, "a change without the version")

        // Somebody changes the protocol; the one who looked at the old version is told so.
        send(
            HttpMethod.Put, "/api/handovers/${handover.id}", s.boss,
            """{"type":"Nový","date":"2026-09-12","participants":"N","expectedUpdatedAt":"${handover.updatedAt}"}""",
        )
        val stale = send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.investor, signBody(handover))
        assertEquals(HttpStatusCode.Conflict, stale.status)
        assertEquals("STALE_VERSION", stale.obj()["code"]!!.jsonPrimitive.content)
        val staleChange = send(
            HttpMethod.Put, "/api/handovers/${handover.id}", s.boss, """{"type":"Třetí","date":"2026-09-12","participants":"N","expectedUpdatedAt":"${handover.updatedAt}"}""",
        )
        assertEquals(HttpStatusCode.Conflict, staleChange.status)
        assertEquals("STALE_VERSION", staleChange.obj()["code"]!!.jsonPrimitive.content)
        assertEquals(0, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))
        assertEquals("Nový", dsl.selectFrom(SITE_HANDOVERS).fetchOne()!!.type)
    }

    @Test
    fun `a person who may not sign is told so before the password, whatever they send`() = testApplication {
        application { module() }
        val s = site()
        val handover = made(s)
        val withoutNumber = createTestUser(role = Role.BOSS, ckaitNumber = null)
        addMember(s.projectId, withoutNumber)

        for ((who, user) in listOf("a worker" to s.worker, "an administrator who is not a member" to s.admin, "a stranger" to s.outsider)) {
            for (body in listOf(signBody(handover), signBody(handover, password = "wrong"), signBody(handover, password = null))) {
                val response = send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", user, body)
                assertEquals(HttpStatusCode.Forbidden, response.status, "$who: $body")
            }
        }
        // A manager without a number is told why, with the code the page recognises, and not asked for a password either.
        for (body in listOf(signBody(handover), signBody(handover, password = "wrong"), signBody(handover, password = null))) {
            val response = send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", withoutNumber, body)
            assertEquals(HttpStatusCode.Forbidden, response.status, body)
            assertEquals("SIGNER_NOT_QUALIFIED", response.obj()["code"]!!.jsonPrimitive.content)
        }
        assertEquals(0, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))
        assertEquals(0, dsl.fetchCount(cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS), "nobody was asked for a password, so no attempt was counted")
    }

    @Test
    fun `a side that is not the person's is a 403 and one that does not exist a 400`() = testApplication {
        application { module() }
        val s = site()
        val handover = made(s)

        assertEquals(HttpStatusCode.Forbidden, send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.boss, signBody(handover, side = "CLIENT")).status)
        assertEquals(HttpStatusCode.Forbidden, send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.investor, signBody(handover, side = "CONTRACTOR")).status)
        assertEquals(HttpStatusCode.BadRequest, send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.boss, signBody(handover, side = "WITNESS")).status)
        assertEquals(0, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))

        assertEquals(HttpStatusCode.OK, send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.inspector, signBody(handover, side = "CLIENT")).status)
        assertEquals(HttpStatusCode.Conflict, send(HttpMethod.Post, "/api/handovers/${handover.id}/sign", s.investor, signBody(handover, side = "CLIENT")).status, "the client's side is signed")
    }

    @Test
    fun `the password is asked at every signature, a wrong one is a 400 and never a 401, and too many wrong ones a 429`() = testApplication {
        application { module() }
        val s = site()
        val handover = made(s)
        val path = "/api/handovers/${handover.id}/sign"

        val missing = send(HttpMethod.Post, path, s.boss, signBody(handover, password = null))
        assertEquals(HttpStatusCode.BadRequest, missing.status)
        assertTrue(missing.error().contains("heslo"), missing.error())

        repeat(5) {
            val wrong = send(HttpMethod.Post, path, s.boss, signBody(handover, password = "Spatne-Heslo-123!"))
            assertEquals(HttpStatusCode.BadRequest, wrong.status, "a wrong password is not a lapsed session")
            assertEquals("Heslo není správné.", wrong.error())
        }
        val tooMany = send(HttpMethod.Post, path, s.boss, signBody(handover))
        assertEquals(HttpStatusCode.TooManyRequests, tooMany.status, "5 wrong answers in 15 minutes are the limit, then even the right one waits")
        assertNotNull(tooMany.headers[HttpHeaders.RetryAfter])
        assertEquals(0, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))

        // Somebody else is not held up by it.
        assertEquals(HttpStatusCode.OK, send(HttpMethod.Post, path, s.investor, signBody(handover)).status)
    }

    @Test
    fun `a right password gives its attempt back, so signing is not what uses the limit up`() = testApplication {
        application { module() }
        val s = site()
        val first = made(s)
        val second = made(s)

        repeat(4) { send(HttpMethod.Post, "/api/handovers/${first.id}/sign", s.boss, signBody(first, password = "Spatne-Heslo-123!")) }
        assertEquals(HttpStatusCode.OK, send(HttpMethod.Post, "/api/handovers/${first.id}/sign", s.boss, signBody(first)).status)
        // 4 wrong answers and a right one: the right one's attempt came back, so 4 are counted, and one more wrong one is allowed.
        assertEquals(HttpStatusCode.BadRequest, send(HttpMethod.Post, "/api/handovers/${second.id}/sign", s.boss, signBody(second, password = "Spatne-Heslo-123!")).status)
        assertEquals(HttpStatusCode.TooManyRequests, send(HttpMethod.Post, "/api/handovers/${second.id}/sign", s.boss, signBody(second)).status)
    }

    @Test
    fun `the text is limited, and a refused protocol is a 400 with the reason in Czech and nothing stored`() = testApplication {
        application { module() }
        val s = site()

        val tooLong = send(HttpMethod.Post, "/api/projects/${s.projectId}/handovers", s.boss, """{"type":"${"x".repeat(201)}","date":"2026-09-11","participants":"N"}""")
        assertEquals(HttpStatusCode.BadRequest, tooLong.status)
        assertEquals("Typ předání může mít nejvýše 200 znaků", tooLong.error())
        val notes = send(HttpMethod.Post, "/api/projects/${s.projectId}/handovers", s.boss, """{"type":"T","date":"2026-09-11","participants":"N","notes":"${"x".repeat(5001)}"}""")
        assertEquals(HttpStatusCode.BadRequest, notes.status)
        assertTrue(notes.error().contains("5000"), notes.error())
        val nul = send(HttpMethod.Post, "/api/projects/${s.projectId}/handovers", s.boss, """{"type":"T\u0000","date":"2026-09-11","participants":"N"}""")
        assertEquals(HttpStatusCode.BadRequest, nul.status)
        assertEquals(HttpStatusCode.BadRequest, send(HttpMethod.Post, "/api/projects/${s.projectId}/handovers", s.boss, "{}").status)
        assertEquals(0, dsl.fetchCount(SITE_HANDOVERS))
    }

    @Test
    fun `who may make, change and read a protocol follows the role in the project`() = testApplication {
        application { module() }
        val s = site()
        val handover = made(s)
        val change = """{"type":"Jiný","date":"2026-09-11","participants":"N","expectedUpdatedAt":"${handover.updatedAt}"}"""

        for (user in listOf(s.investor, s.inspector, s.admin, s.outsider)) {
            assertEquals(HttpStatusCode.Forbidden, send(HttpMethod.Post, "/api/projects/${s.projectId}/handovers", user, create()).status)
            assertEquals(HttpStatusCode.Forbidden, send(HttpMethod.Put, "/api/handovers/${handover.id}", user, change).status)
            assertEquals(HttpStatusCode.Forbidden, send(HttpMethod.Delete, "/api/handovers/${handover.id}", user).status)
        }
        assertEquals(HttpStatusCode.Forbidden, send(HttpMethod.Put, "/api/handovers/${handover.id}", s.worker, change).status, "a worker changes only their own")
        for (user in listOf(s.boss, s.worker, s.investor, s.inspector, s.admin)) {
            assertEquals(HttpStatusCode.OK, send(HttpMethod.Get, "/api/handovers/${handover.id}", user).status)
        }
        assertEquals(HttpStatusCode.Forbidden, send(HttpMethod.Get, "/api/handovers/${handover.id}", s.outsider).status)
        assertEquals(HttpStatusCode.NotFound, send(HttpMethod.Get, "/api/handovers/${UUID.randomUUID()}", s.boss).status)
        assertEquals(HttpStatusCode.NotFound, send(HttpMethod.Post, "/api/handovers/${UUID.randomUUID()}/sign", s.boss, signBody(handover)).status)
    }
}
