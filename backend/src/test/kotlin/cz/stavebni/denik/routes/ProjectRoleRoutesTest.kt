package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/**
 * What a person may do in a project follows the role they hold IN THAT PROJECT, not their global role: the same person
 * can be the site manager of one project and an ordinary worker in another.
 */
class ProjectRoleRoutesTest : BaseIntegrationTest() {

    private suspend fun project(owner: SessionUser, name: String): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = name, address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor",
                siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private suspend fun ApplicationTestBuilder.call(method: HttpMethod, path: String, user: SessionUser, body: String = "{}"): HttpResponse =
        client.request(path) {
            this.method = method
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            contentType(ContentType.Application.Json)
            if (method != HttpMethod.Get && method != HttpMethod.Delete) setBody(body)
        }

    private fun roleIn(projectId: UUID, user: SessionUser): String? =
        dsl.select(PROJECT_MEMBERS.ROLE).from(PROJECT_MEMBERS)
            .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(user.id)))
            .fetchOne(PROJECT_MEMBERS.ROLE)?.name

    private fun addMemberBody(user: SessionUser, role: String) = """{"userId":"${user.id}","role":"$role"}"""

    // ------------------------------------------------------------------ one person, two projects

    @Test
    fun `the same person signs in the project they manage and not in the one where they only work`() = testApplication {
        application { module() }
        val me = createTestUser(nickname = "me", role = Role.BOSS)
        val other = createTestUser(nickname = "other_boss", role = Role.BOSS)
        val mine = project(me, "Mine")
        val theirs = project(other, "Theirs")
        addMember(theirs, me, Role.WORKER) // a global BOSS who is a worker here
        val myReport = DailyReportService.createReport(me, mine, "2026-09-29")
        val theirReport = DailyReportService.createReport(other, theirs, "2026-09-29")

        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/reports/${myReport.id}/sign", me).status, "manager of Mine")
        assertEquals(HttpStatusCode.Forbidden, call(HttpMethod.Post, "/api/reports/${theirReport.id}/sign", me).status, "worker in Theirs")
        // ... and a worker may still add to the diary of Theirs, but only correct their own entries.
        val newEntry = call(HttpMethod.Post, "/api/projects/$theirs/reports", me, """{"date":"2026-09-30"}""")
        assertTrue(newEntry.status.isSuccess() || newEntry.status == HttpStatusCode.Created, newEntry.bodyAsText())
    }

    @Test
    fun `a person who is only a worker in a project cannot manage its members, whatever their global role`() = testApplication {
        application { module() }
        val me = createTestUser(nickname = "me", role = Role.BOSS)
        val other = createTestUser(nickname = "other_boss", role = Role.BOSS)
        val newcomer = createTestUser(nickname = "newcomer", role = Role.WORKER)
        val theirs = project(other, "Theirs")
        addMember(theirs, me, Role.WORKER)

        val add = call(HttpMethod.Post, "/api/projects/$theirs/members", me, addMemberBody(newcomer, "WORKER"))

        assertEquals(HttpStatusCode.Forbidden, add.status)
        assertNull(roleIn(theirs, newcomer))
        assertEquals(HttpStatusCode.Forbidden, call(HttpMethod.Post, "/api/projects/$theirs/authorized-persons", me, """{"name":"Karel"}""").status)
    }

    @Test
    fun `a global worker who manages a project can sign and manage it, but cannot create projects`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val promoted = createTestUser(nickname = "promoted", role = Role.WORKER)
        val newcomer = createTestUser(nickname = "newcomer", role = Role.WORKER)
        val p = project(boss, "P")
        addMember(p, promoted, Role.BOSS)
        val report = DailyReportService.createReport(boss, p, "2026-09-29")

        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/reports/${report.id}/sign", promoted).status)
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/projects/$p/members", promoted, addMemberBody(newcomer, "WORKER")).status)
        assertEquals("WORKER", roleIn(p, newcomer))
        assertEquals(HttpStatusCode.Created, call(HttpMethod.Post, "/api/projects/$p/authorized-persons", promoted, """{"name":"Karel"}""").status)

        // The global role still decides who creates projects.
        val body = """{"name":"New","address":"A","cadastralArea":"C","parcelNumbers":"1","builder":"B","contractor":"C","siteManagerId":"${promoted.id}"}"""
        assertEquals(HttpStatusCode.Forbidden, call(HttpMethod.Post, "/api/projects", promoted, body).status)
    }

    @Test
    fun `an inspector in the project acknowledges, a global inspector who works there does not`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val asInspector = createTestUser(nickname = "supervisor", role = Role.WORKER)
        val globalInspector = createTestUser(nickname = "global_inspector", role = Role.INSPECTOR)
        val p = project(boss, "P")
        addMember(p, asInspector, Role.INSPECTOR)
        addMember(p, globalInspector, Role.WORKER)
        val report = DailyReportService.createReport(boss, p, "2026-09-29")
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/reports/${report.id}/sign", boss).status)

        assertEquals(HttpStatusCode.Forbidden, call(HttpMethod.Post, "/api/reports/${report.id}/acknowledge", globalInspector).status)
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/reports/${report.id}/acknowledge", asInspector).status)
    }

    @Test
    fun `a changed role applies to the very next request`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val deputy = createTestUser(nickname = "deputy", role = Role.BOSS)
        val p = project(boss, "P")
        addMember(p, deputy, Role.BOSS)
        val first = DailyReportService.createReport(boss, p, "2026-09-29")
        val second = DailyReportService.createReport(boss, p, "2026-09-30")
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/reports/${first.id}/sign", deputy).status)

        // The manager demotes the deputy: the deputy's next signature is refused, with the same session.
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/projects/$p/members", boss, addMemberBody(deputy, "WORKER")).status)

        assertEquals(HttpStatusCode.Forbidden, call(HttpMethod.Post, "/api/reports/${second.id}/sign", deputy).status)
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/reports/${second.id}/sign", boss).status)
    }

    // ------------------------------------------------------------------ administrators

    @Test
    fun `an administrator joins as the role they are given and has no more rights than that role`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val admin = createTestUser(nickname = "admin", role = Role.BOSS, isAdmin = true)
        val p = project(boss, "P")
        val report = DailyReportService.createReport(boss, p, "2026-09-29")

        // Not a member: may read, may not write.
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Get, "/api/projects/$p", admin).status)
        assertEquals(HttpStatusCode.Forbidden, call(HttpMethod.Post, "/api/reports/${report.id}/sign", admin).status)

        // The audited way in (decision D1): as a worker, the admin still cannot sign.
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/projects/$p/members", admin, addMemberBody(admin, "WORKER")).status)
        assertEquals("WORKER", roleIn(p, admin))
        assertEquals(HttpStatusCode.Forbidden, call(HttpMethod.Post, "/api/reports/${report.id}/sign", admin).status)
        // ... and cannot promote themselves afterwards.
        assertEquals(HttpStatusCode.Conflict, call(HttpMethod.Post, "/api/projects/$p/members", admin, addMemberBody(admin, "BOSS")).status)
        assertEquals("WORKER", roleIn(p, admin))
    }

    @Test
    fun `an administrator whose own role is worker may still manage members`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val admin = createTestUser(nickname = "admin", role = Role.WORKER, isAdmin = true)
        val newcomer = createTestUser(nickname = "newcomer", role = Role.WORKER)
        val p = project(boss, "P")

        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/projects/$p/members", admin, addMemberBody(newcomer, "WORKER")).status)
    }

    // ------------------------------------------------------------------ the project keeps its manager

    @Test
    fun `the site manager cannot be removed or demoted and nobody changes their own role`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val deputy = createTestUser(nickname = "deputy", role = Role.BOSS)
        val p = project(boss, "P")
        addMember(p, deputy, Role.BOSS)

        // The deputy tries to push the site manager out, or down.
        assertEquals(HttpStatusCode.Conflict, call(HttpMethod.Delete, "/api/projects/$p/members/${boss.id}", deputy).status)
        assertEquals(HttpStatusCode.Conflict, call(HttpMethod.Post, "/api/projects/$p/members", deputy, addMemberBody(boss, "WORKER")).status)
        assertEquals("BOSS", roleIn(p, boss))

        // Nobody changes their own role, the site manager least of all.
        assertEquals(HttpStatusCode.Conflict, call(HttpMethod.Post, "/api/projects/$p/members", boss, addMemberBody(boss, "WORKER")).status)
        assertEquals(HttpStatusCode.Conflict, call(HttpMethod.Post, "/api/projects/$p/members", deputy, addMemberBody(deputy, "WORKER")).status)
        assertEquals("BOSS", roleIn(p, deputy))

        // A deputy who is not the site manager can be demoted and removed by the manager.
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Post, "/api/projects/$p/members", boss, addMemberBody(deputy, "WORKER")).status)
        assertEquals(HttpStatusCode.NoContent, call(HttpMethod.Delete, "/api/projects/$p/members/${deputy.id}", boss).status)
        assertNull(roleIn(p, deputy))
    }

    @Test
    fun `a project is never left without a manager`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val admin = createTestUser(nickname = "admin", role = Role.BOSS, isAdmin = true)
        val p = project(boss, "P")
        // Old data: the named site manager is someone who is not a member at all.
        val ghost = createTestUser(nickname = "ghost", role = Role.WORKER)
        dsl.update(PROJECTS).set(PROJECTS.SITEMANAGERID, ghost.id).where(PROJECTS.ID.eq(p)).execute()

        // The only manager cannot be demoted or removed, not even by an administrator.
        assertEquals(HttpStatusCode.Conflict, call(HttpMethod.Post, "/api/projects/$p/members", admin, addMemberBody(boss, "WORKER")).status)
        assertEquals(HttpStatusCode.Conflict, call(HttpMethod.Delete, "/api/projects/$p/members/${boss.id}", admin).status)
        assertEquals("BOSS", roleIn(p, boss))
    }

    // ------------------------------------------------------------------ what the client is told

    @Test
    fun `a project says which role the caller holds in it`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val me = createTestUser(nickname = "me", role = Role.BOSS)
        val admin = createTestUser(nickname = "admin", role = Role.WORKER, isAdmin = true)
        val mine = project(me, "Mine")
        val theirs = project(boss, "Theirs")
        addMember(theirs, me, Role.INSPECTOR)

        fun myRoles(list: String): Map<String, String?> =
            Json.parseToJsonElement(list).jsonArray.associate {
                val o = it.jsonObject
                o["name"]!!.jsonPrimitive.content to o["myRole"]?.jsonPrimitive?.contentOrNull
            }

        assertEquals(mapOf("Mine" to "BOSS", "Theirs" to "INSPECTOR"), myRoles(call(HttpMethod.Get, "/api/projects", me).bodyAsText()))
        assertEquals("INSPECTOR", Json.parseToJsonElement(call(HttpMethod.Get, "/api/projects/$theirs", me).bodyAsText()).jsonObject["myRole"]!!.jsonPrimitive.content)
        assertEquals("BOSS", Json.parseToJsonElement(call(HttpMethod.Get, "/api/projects/$mine", me).bodyAsText()).jsonObject["myRole"]!!.jsonPrimitive.content)

        // An administrator who is not a member has no role in the project.
        assertEquals(mapOf("Mine" to null, "Theirs" to null), myRoles(call(HttpMethod.Get, "/api/projects", admin).bodyAsText()))
        assertNull(Json.parseToJsonElement(call(HttpMethod.Get, "/api/projects/$mine", admin).bodyAsText()).jsonObject["myRole"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun `the user picker is for administrators, people who create projects and anyone who manages a project`() = testApplication {
        application { module() }
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val manager = createTestUser(nickname = "manager", role = Role.WORKER)
        val plainWorker = createTestUser(nickname = "plain_worker", role = Role.WORKER)
        val admin = createTestUser(nickname = "admin", role = Role.WORKER, isAdmin = true)
        val p = project(boss, "P")
        addMember(p, manager, Role.BOSS)
        addMember(p, plainWorker, Role.WORKER)

        assertEquals(HttpStatusCode.OK, call(HttpMethod.Get, "/api/users/options", boss).status, "global BOSS")
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Get, "/api/users/options", manager).status, "manages a project")
        assertEquals(HttpStatusCode.OK, call(HttpMethod.Get, "/api/users/options", admin).status, "administrator")
        assertEquals(HttpStatusCode.Forbidden, call(HttpMethod.Get, "/api/users/options", plainWorker).status, "manages nothing")
    }

    @Test
    fun `a membership cannot be inserted without a role`() {
        val boss = createTestUser(nickname = "boss", role = Role.BOSS)
        val worker = createTestUser(nickname = "worker", role = Role.WORKER)
        val p = kotlinx.coroutines.runBlocking { project(boss, "P") }

        val failure = runCatching {
            dsl.insertInto(PROJECT_MEMBERS).set(PROJECT_MEMBERS.PROJECTID, p).set(PROJECT_MEMBERS.USERID, worker.id).execute()
        }

        assertTrue(failure.isFailure, "no default role: a forgotten column must not make someone a project manager")
        assertNull(roleIn(p, worker))
    }
}
