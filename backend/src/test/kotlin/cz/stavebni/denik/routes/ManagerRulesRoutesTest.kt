package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.OffsetDateTime
import java.util.UUID

/** Decision D2 as the client sees it (backlog A1): the status codes, the messages, the warning and the picker flag. */
class ManagerRulesRoutesTest : BaseIntegrationTest() {

    private fun body(siteManager: String) =
        """{"name":"Dům","address":"Karlova 15","cadastralArea":"Brno","parcelNumbers":"1","builder":"Město","contractor":"Stavitel","siteManagerId":"$siteManager"}"""

    private suspend fun ApplicationTestBuilder.send(user: SessionUser, method: HttpMethod, path: String, payload: String? = null): HttpResponse =
        client.request(path) {
            this.method = method
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            if (payload != null) {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
        }

    private fun JsonObject.text(key: String): String? = get(key).let { if (it == null || it is JsonNull) null else it.jsonPrimitive.content }

    private fun errorOf(response: String): String = Json.parseToJsonElement(response).jsonObject.text("error") ?: ""

    private suspend fun newProject(creator: SessionUser, siteManager: SessionUser = creator, name: String = "Dům"): ProjectDto =
        ProjectService.createProject(
            creator,
            ProjectDto(
                id = "", name = name, address = "Karlova 15", cadastralArea = "Brno", parcelNumbers = "1",
                builder = "Město", contractor = "Stavitel", siteManagerId = siteManager.id.toString(),
            ),
        )

    // ------------------------------------------------------------------ creating a project

    @Test
    fun `every refusal of a site manager is a 409 with a reason, and nothing is created`() = testApplication {
        application { module() }
        val creator = createTestUser(role = Role.BOSS)
        val withoutNumber = createTestUser(role = Role.BOSS, ckaitNumber = null)
        val inactive = createTestUser(role = Role.BOSS).also { dsl.update(USERS).set(USERS.ISACTIVE, false).where(USERS.ID.eq(it.id)).execute() }
        val deleted = createTestUser(role = Role.BOSS).also {
            dsl.update(USERS).set(USERS.ISACTIVE, false).set(USERS.DELETEDAT, OffsetDateTime.now()).where(USERS.ID.eq(it.id)).execute()
        }

        val cases = mapOf(
            "no ČKAIT number" to (withoutNumber.id.toString() to "ČKAIT"),
            "deactivated" to (inactive.id.toString() to "deaktivovaný"),
            "deleted" to (deleted.id.toString() to "smazaný"),
            "unknown" to (UUID.randomUUID().toString() to "neexistuje"),
        )
        for ((what, case) in cases) {
            val response = send(creator, HttpMethod.Post, "/api/projects", body(case.first))
            assertEquals(HttpStatusCode.Conflict, response.status, "$what: ${response.bodyAsText()}")
            assertTrue(errorOf(response.bodyAsText()).contains(case.second), "$what says why: ${response.bodyAsText()}")
        }
        // A creator who holds no number is a refusal of the same kind.
        val unqualifiedCreator = createTestUser(role = Role.BOSS, ckaitNumber = null)
        val qualified = createTestUser(role = Role.WORKER, ckaitNumber = "0054321")
        assertEquals(HttpStatusCode.Conflict, send(unqualifiedCreator, HttpMethod.Post, "/api/projects", body(qualified.id.toString())).status)
        assertEquals(0, dsl.fetchCount(PROJECTS))
        assertEquals(0, dsl.fetchCount(AUDIT_LOG))
    }

    @Test
    fun `a qualified site manager is added as a manager, and no other manager can demote or remove them`() = testApplication {
        application { module() }
        val creator = createTestUser(role = Role.BOSS)
        // The case that used to be reachable from the normal form: a user whose account role is not BOSS.
        val manager = createTestUser(role = Role.WORKER, ckaitNumber = "0054321")

        val created = send(creator, HttpMethod.Post, "/api/projects", body(manager.id.toString()))
        assertEquals(HttpStatusCode.OK, created.status, created.bodyAsText())
        val projectId = Json.parseToJsonElement(created.bodyAsText()).jsonObject.text("id")!!

        fun role(user: SessionUser) = dsl.select(PROJECT_MEMBERS.ROLE).from(PROJECT_MEMBERS)
            .where(PROJECT_MEMBERS.PROJECTID.eq(UUID.fromString(projectId)).and(PROJECT_MEMBERS.USERID.eq(user.id))).fetchOne(PROJECT_MEMBERS.ROLE)?.name
        assertEquals("BOSS", role(manager))
        assertEquals(HttpStatusCode.Conflict, send(creator, HttpMethod.Post, "/api/projects/$projectId/members", """{"userId":"${manager.id}","role":"WORKER"}""").status)
        assertEquals(HttpStatusCode.Conflict, send(creator, HttpMethod.Delete, "/api/projects/$projectId/members/${manager.id}").status)
        assertEquals("BOSS", role(manager))
    }

    // ------------------------------------------------------------------ editing a number

    @Test
    fun `an edit of the number of a manager answers with a warning, and one of a person who manages nothing without`() = testApplication {
        application { module() }
        val admin = createTestUser(nickname = "admin", role = Role.BOSS, isAdmin = true)
        val manager = createTestUser(role = Role.BOSS, ckaitNumber = "0012345")
        val worker = createTestUser(role = Role.WORKER, ckaitNumber = "0012346")
        newProject(manager, name = "Stavba pod dohledem")

        val warned = send(admin, HttpMethod.Patch, "/api/users/${manager.id}", """{"ckaitNumber":""}""")
        val plain = send(admin, HttpMethod.Patch, "/api/users/${worker.id}", """{"ckaitNumber":""}""")

        assertEquals(HttpStatusCode.OK, warned.status, warned.bodyAsText())
        val warning = Json.parseToJsonElement(warned.bodyAsText()).jsonObject.text("warning")
        assertNotNull(warning, "the SPA shows it after saving: ${warned.bodyAsText()}")
        assertTrue(warning!!.contains("Stavba pod dohledem"), warning)
        assertEquals(HttpStatusCode.OK, plain.status)
        assertNull(Json.parseToJsonElement(plain.bodyAsText()).jsonObject.text("warning"))
    }

    @Test
    fun `an administrator who edits their own number is refused with a 409, and may edit somebody else's`() = testApplication {
        application { module() }
        val admin = createTestUser(nickname = "admin", role = Role.BOSS, isAdmin = true, ckaitNumber = null)
        val worker = createTestUser(role = Role.WORKER, ckaitNumber = null)

        val own = send(admin, HttpMethod.Patch, "/api/users/${admin.id}", """{"ckaitNumber":"0000001"}""")
        val other = send(admin, HttpMethod.Patch, "/api/users/${worker.id}", """{"ckaitNumber":"0000002"}""")
        val ownName = send(admin, HttpMethod.Patch, "/api/users/${admin.id}", """{"displayName":"Nové Jméno","ckaitNumber":""}""")

        assertEquals(HttpStatusCode.Conflict, own.status, own.bodyAsText())
        assertTrue(errorOf(own.bodyAsText()).contains("ČKAIT"), own.bodyAsText())
        assertEquals(HttpStatusCode.OK, other.status, other.bodyAsText())
        assertEquals(HttpStatusCode.OK, ownName.status, "an unchanged number is not a change: ${ownName.bodyAsText()}")
        assertNull(dsl.selectFrom(USERS).where(USERS.ID.eq(admin.id)).fetchSingle().ckaitnumber)
        assertEquals("0000002", dsl.selectFrom(USERS).where(USERS.ID.eq(worker.id)).fetchSingle().ckaitnumber)
    }

    // ------------------------------------------------------------------ the picker

    @Test
    fun `the options say whether a person holds a number, and never what it is`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS, ckaitNumber = "9876543")
        createTestUser(nickname = "qualified", role = Role.WORKER, ckaitNumber = "1234567")
        createTestUser(nickname = "none", role = Role.WORKER, ckaitNumber = null)
        createTestUser(nickname = "blank", role = Role.WORKER, ckaitNumber = "  ")

        val response = send(boss, HttpMethod.Get, "/api/users/options")

        assertEquals(HttpStatusCode.OK, response.status)
        val text = response.bodyAsText()
        assertFalse(text.contains("9876543") || text.contains("1234567"), "the number is not in the list: $text")
        assertFalse(text.contains("ckaitNumber"), "no field for it either: $text")
        val flags = (Json.parseToJsonElement(text) as JsonArray).associate { it.jsonObject.text("nickname")!! to it.jsonObject.getValue("hasCkait").jsonPrimitive.boolean }
        assertEquals(mapOf("boss" to true, "qualified" to true, "none" to false, "blank" to false), flags)
    }

    // ------------------------------------------------------------------ users who are site managers

    @Test
    fun `a site manager can be switched off at once and the answer warns, deleting is refused until the project has another`() = testApplication {
        application { module() }
        val admin = createTestUser(nickname = "admin", role = Role.BOSS, isAdmin = true)
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val deputy = createTestUser(nickname = "deputy", role = Role.BOSS)
        val created = newProject(boss, name = "Bytový dům Špitálka")
        addMember(UUID.fromString(created.id), deputy, Role.BOSS)

        val delete = send(admin, HttpMethod.Delete, "/api/users/${boss.id}")
        assertEquals(HttpStatusCode.Conflict, delete.status, delete.bodyAsText())
        assertTrue(errorOf(delete.bodyAsText()).contains("Bytový dům Špitálka"), delete.bodyAsText())

        val deactivate = send(admin, HttpMethod.Post, "/api/users/${boss.id}/deactivate")
        assertEquals(HttpStatusCode.OK, deactivate.status, deactivate.bodyAsText())
        val warning = Json.parseToJsonElement(deactivate.bodyAsText()).jsonObject.text("warning")
        assertNotNull(warning, "the admin is told which project is left without an active site manager: ${deactivate.bodyAsText()}")
        assertTrue(warning!!.contains("Bytový dům Špitálka"), warning)
        assertFalse(dsl.selectFrom(USERS).where(USERS.ID.eq(boss.id)).fetchSingle().isactive!!)

        // The deputy, an active manager of the project, replaces the switched-off site manager; after that the user can be deleted.
        val replaced = send(deputy, HttpMethod.Put, "/api/projects/${created.id}/site-manager", """{"siteManagerId":"${deputy.id}","updatedAt":"${created.updatedAt}"}""")
        assertEquals(HttpStatusCode.OK, replaced.status, replaced.bodyAsText())
        assertEquals(HttpStatusCode.NoContent, send(admin, HttpMethod.Delete, "/api/users/${boss.id}").status)
    }

    @Test
    fun `a switched-off site manager cannot sign, and the project is signed again only by an active qualified manager`() = testApplication {
        application { module() }
        val admin = createTestUser(nickname = "admin", role = Role.BOSS, isAdmin = true)
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val worker = createTestUser(nickname = "worker", role = Role.WORKER)
        val successor = createTestUser(nickname = "successor", role = Role.WORKER, ckaitNumber = "0054321")
        val created = newProject(boss)
        val projectId = UUID.fromString(created.id)
        addMember(projectId, worker, Role.WORKER)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29", workDescription = "Betonáž")
        // the body of a sign request is made when it is sent: it names the part A of that moment
        fun password() = signBody(projectId)
        val bossToken = generateJwtToken(boss)

        assertEquals(HttpStatusCode.OK, send(admin, HttpMethod.Post, "/api/users/${boss.id}/deactivate").status)

        // The site manager's session ended with the deactivation; the only other member is a worker: nobody can sign.
        val old = client.post("/api/reports/${report.id}/sign") {
            header(HttpHeaders.Authorization, "Bearer $bossToken")
            contentType(ContentType.Application.Json)
            setBody(password())
        }
        assertEquals(HttpStatusCode.Unauthorized, old.status, old.bodyAsText())
        assertEquals(HttpStatusCode.Forbidden, send(worker, HttpMethod.Post, "/api/reports/${report.id}/sign", password()).status)
        assertNull(dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(report.id))).fetchSingle().lockedat, "nothing was signed")

        // Signing needs an active manager of the project who holds a ČKAIT number, not specifically the site manager:
        // the administrator adds one (decision D1) and that person signs.
        assertEquals(HttpStatusCode.OK, send(admin, HttpMethod.Post, "/api/projects/$projectId/members", """{"userId":"${successor.id}","role":"BOSS"}""").status)
        assertEquals(HttpStatusCode.OK, send(successor, HttpMethod.Post, "/api/reports/${report.id}/sign", password()).status)
    }
}
