package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/**
 * The scope of authorisation and responsibility of the persons who ensure the technical management of the works (příloha 12
 * A d)): a text on the membership of a manager (BOSS) or of the supervision (INSPECTOR), set by the manager of the project,
 * audited with what it was and what it became, and bounded like the other texts of people.
 */
class ProjectMemberScopeTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val projectId: UUID)

    private suspend fun site(): Site {
        val boss = createTestUser(nickname = "boss", displayName = "Jan Stavbyvedoucí", role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Stavba", address = "Ulice 1", cadastralArea = "Brno", parcelNumbers = "1/1",
                builder = "Stavebník", contractor = "Zhotovitel", siteManagerId = boss.id.toString(),
            ),
        )
        return Site(boss, UUID.fromString(project.id))
    }

    private fun scopeOf(projectId: UUID, user: SessionUser): String? =
        dsl.select(PROJECT_MEMBERS.SCOPE).from(PROJECT_MEMBERS).where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(user.id))).fetchOne(PROJECT_MEMBERS.SCOPE)

    private fun roleOf(projectId: UUID, user: SessionUser): String? =
        dsl.select(PROJECT_MEMBERS.ROLE).from(PROJECT_MEMBERS).where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(user.id))).fetchOne(PROJECT_MEMBERS.ROLE)?.name

    private fun memberRows() = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("project.member.add")).orderBy(AUDIT_LOG.ID.asc()).fetch()

    private fun add(actor: SessionUser, projectId: UUID, user: SessionUser, role: String, scope: String? = null) =
        runBlocking { ProjectMemberService.addMember(actor, projectId, AddMemberRequest(user.id.toString(), role, scope)) }

    @Test
    fun `the manager of the project states the scope of a manager and of the supervision, and the list returns it`() = runBlocking<Unit> {
        val s = site()
        val supervisor = createTestUser(nickname = "dozor", displayName = "Ing. Dozor", role = Role.INSPECTOR)
        val deputy = createTestUser(nickname = "deputy", displayName = "Marie Zástupce", role = Role.BOSS)

        add(s.boss, s.projectId, supervisor, "INSPECTOR", "Technický dozor stavebníka")
        val members = add(s.boss, s.projectId, deputy, "BOSS", "  Zástupce stavbyvedoucího, objekty SO 02 a SO 03  ")

        assertEquals("Technický dozor stavebníka", scopeOf(s.projectId, supervisor))
        assertEquals("Zástupce stavbyvedoucího, objekty SO 02 a SO 03", scopeOf(s.projectId, deputy), "trimmed")
        assertEquals(
            mapOf("Ing. Dozor" to "Technický dozor stavebníka", "Marie Zástupce" to "Zástupce stavbyvedoucího, objekty SO 02 a SO 03", "Jan Stavbyvedoucí" to null),
            members.associate { it.displayName to it.scope },
        )
    }

    @Test
    fun `a scope that is not mentioned is kept, an empty one clears it, and a new one replaces it`() = runBlocking<Unit> {
        val s = site()
        val supervisor = createTestUser(nickname = "dozor", role = Role.INSPECTOR)
        add(s.boss, s.projectId, supervisor, "INSPECTOR", "Dozor A")

        add(s.boss, s.projectId, supervisor, "INSPECTOR")
        assertEquals("Dozor A", scopeOf(s.projectId, supervisor), "not mentioned: kept")

        add(s.boss, s.projectId, supervisor, "INSPECTOR", "Dozor B")
        assertEquals("Dozor B", scopeOf(s.projectId, supervisor))

        add(s.boss, s.projectId, supervisor, "INSPECTOR", "   ")
        assertNull(scopeOf(s.projectId, supervisor), "an empty text clears it")
    }

    @Test
    fun `a change of the scope is audited with what it was and what it became`() = runBlocking<Unit> {
        val s = site()
        val supervisor = createTestUser(nickname = "dozor", role = Role.INSPECTOR)
        add(s.boss, s.projectId, supervisor, "INSPECTOR", "Dozor A")
        add(s.boss, s.projectId, supervisor, "INSPECTOR", "Dozor B")

        val rows = memberRows().filter { it.get(AUDIT_LOG.ENTITY_TYPE) == "project" }.map { it.auditPayload() }
        val added = rows.first { it["after"]!!.jsonObject["userId"]!!.jsonPrimitive.content == supervisor.id.toString() }
        assertEquals(JsonNull, added["before"], "a new member has no before")
        assertEquals("Dozor A", added["after"]!!.jsonObject["scope"]!!.jsonPrimitive.content)
        val changed = rows.last()
        assertEquals("Dozor A", changed["before"]!!.jsonObject["scope"]!!.jsonPrimitive.content)
        assertEquals("Dozor B", changed["after"]!!.jsonObject["scope"]!!.jsonPrimitive.content)
        assertEquals("INSPECTOR", changed["after"]!!.jsonObject["role"]!!.jsonPrimitive.content)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a member without a scope is audited as before, with no scope in the row`() = runBlocking<Unit> {
        val s = site()
        val worker = createTestUser(nickname = "worker", role = Role.WORKER)
        add(s.boss, s.projectId, worker, "WORKER")

        val after = memberRows().last().auditPayload()["after"]!!.jsonObject
        assertEquals(setOf("userId", "role"), after.keys)
    }

    @Test
    fun `only a manager and the supervision have a scope, any other role is refused, and a role change drops it`() = runBlocking<Unit> {
        val s = site()
        val person = createTestUser(nickname = "person", role = Role.WORKER, ckaitNumber = "0055555")

        for (role in listOf("WORKER", "INVESTOR")) {
            assertThrows<IllegalArgumentException>(role) { add(s.boss, s.projectId, person, role, "Něco") }
        }
        assertNull(roleOf(s.projectId, person), "a refused request changes nothing")

        add(s.boss, s.projectId, person, "INSPECTOR", "Dozor")
        add(s.boss, s.projectId, person, "BOSS")
        assertEquals("Dozor", scopeOf(s.projectId, person), "from supervision to manager the scope stays unless it is changed")
        add(s.boss, s.projectId, person, "WORKER")
        assertNull(scopeOf(s.projectId, person), "a worker has no scope")
        add(s.boss, s.projectId, person, "INSPECTOR")
        assertNull(scopeOf(s.projectId, person), "and does not get the old one back")
    }

    @Test
    fun `the scope is limited like the other texts of people`() = runBlocking<Unit> {
        val s = site()
        val supervisor = createTestUser(nickname = "dozor", role = Role.INSPECTOR)

        assertThrows<IllegalArgumentException> { add(s.boss, s.projectId, supervisor, "INSPECTOR", "x".repeat(ProjectMemberService.MAX_SCOPE_CHARS + 1)) }
        assertThrows<IllegalArgumentException> { add(s.boss, s.projectId, supervisor, "INSPECTOR", "Dozor\u0000") }
        assertNull(roleOf(s.projectId, supervisor))

        // An emoji is one character, as a person counts it: 500 of them are at the limit although they are 1000 UTF-16 units.
        add(s.boss, s.projectId, supervisor, "INSPECTOR", "😀".repeat(ProjectMemberService.MAX_SCOPE_CHARS))
        assertEquals("😀".repeat(ProjectMemberService.MAX_SCOPE_CHARS), scopeOf(s.projectId, supervisor))
    }

    @Test
    fun `the scope is set by the manager of the project, not by a worker or a stranger`() = runBlocking<Unit> {
        val s = site()
        val worker = createTestUser(nickname = "worker", role = Role.WORKER)
        val supervisor = createTestUser(nickname = "dozor", role = Role.INSPECTOR)
        val stranger = createTestUser(nickname = "stranger", role = Role.BOSS)
        add(s.boss, s.projectId, worker, "WORKER")
        add(s.boss, s.projectId, supervisor, "INSPECTOR", "Dozor")

        assertThrows<ForbiddenException> { add(worker, s.projectId, supervisor, "INSPECTOR", "Zfalšováno") }
        assertThrows<ForbiddenException> { add(supervisor, s.projectId, supervisor, "INSPECTOR", "Sám sobě") }
        assertThrows<ForbiddenException> { add(stranger, s.projectId, supervisor, "INSPECTOR", "Cizí") }
        assertEquals("Dozor", scopeOf(s.projectId, supervisor))
    }

    @Test
    fun `a manager may state their own scope, but nobody changes their own role`() = runBlocking<Unit> {
        val s = site()

        add(s.boss, s.projectId, s.boss, "BOSS", "Celé dílo")
        assertEquals("Celé dílo", scopeOf(s.projectId, s.boss))

        assertThrows<ConflictException> { add(s.boss, s.projectId, s.boss, "WORKER") }
        assertThrows<ConflictException> { add(s.boss, s.projectId, s.boss, "INSPECTOR", "Jen dozor") }
        assertEquals("BOSS", roleOf(s.projectId, s.boss))
        assertEquals("Celé dílo", scopeOf(s.projectId, s.boss))
    }

    @Test
    fun `an administrator who is not a member may add a member with a scope, as the audited way in`() = runBlocking<Unit> {
        val s = site()
        val admin = createTestUser(nickname = "admin", role = Role.WORKER, isAdmin = true)
        val supervisor = createTestUser(nickname = "dozor", role = Role.INSPECTOR)

        add(admin, s.projectId, supervisor, "INSPECTOR", "Dozor")

        assertEquals("Dozor", scopeOf(s.projectId, supervisor))
    }

    @Test
    fun `removing a member audits the scope they had`() = runBlocking<Unit> {
        val s = site()
        val supervisor = createTestUser(nickname = "dozor", role = Role.INSPECTOR)
        add(s.boss, s.projectId, supervisor, "INSPECTOR", "Dozor")

        ProjectMemberService.removeMember(s.boss, s.projectId, supervisor.id)

        val removed = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("project.member.remove")).fetchSingle().auditPayload()
        assertEquals("Dozor", removed["before"]!!.jsonObject["scope"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, removed["after"])
    }

    // --- how many ---------------------------------------------------------------------------------

    /** Plain rows, without a password hash that takes its time: the test is about how many, not about who. */
    private fun insertUsers(count: Int): List<UUID> = (1..count).map { n ->
        val id = UUID.randomUUID()
        dsl.insertInto(USERS)
            .set(USERS.ID, id).set(USERS.NICKNAME, "bulk$n").set(USERS.DISPLAYNAME, "Člen $n").set(USERS.PASSWORDHASH, "x")
            .set(USERS.ROLE, cz.stavebni.denik.jooq.enums.Role.INSPECTOR).set(USERS.ISACTIVE, true).set(USERS.MUSTCHANGEPWD, false)
            .execute()
        id
    }

    @Test
    fun `a project has at most 100 managers and members of the supervision, so that part A stays small`() = runBlocking<Unit> {
        val s = site()
        // The creator is the first; 99 more fill the project up (direct inserts: the test is about the 101st).
        for (id in insertUsers(PartASnapshot.MAX_PERSONS - 1)) {
            dsl.insertInto(PROJECT_MEMBERS).set(PROJECT_MEMBERS.PROJECTID, s.projectId).set(PROJECT_MEMBERS.USERID, id)
                .set(PROJECT_MEMBERS.ROLE, cz.stavebni.denik.jooq.enums.Role.INSPECTOR).execute()
        }
        val one = createTestUser(nickname = "one_more", role = Role.INSPECTOR)
        val worker = createTestUser(nickname = "worker", role = Role.WORKER)

        assertThrows<ConflictException> { add(s.boss, s.projectId, one, "INSPECTOR", "Navíc") }
        assertThrows<ConflictException> { add(s.boss, s.projectId, createTestUser(nickname = "another_boss", role = Role.BOSS), "BOSS") }
        assertNull(roleOf(s.projectId, one))
        // Others are not counted, and a member who is already there can change their scope and role among the two.
        add(s.boss, s.projectId, worker, "WORKER")
        add(s.boss, s.projectId, s.boss, "BOSS", "Pořád to jde")
        assertEquals(PartASnapshot.MAX_PERSONS, dsl.fetchCount(PROJECT_MEMBERS, PROJECT_MEMBERS.ROLE.`in`(cz.stavebni.denik.jooq.enums.Role.BOSS, cz.stavebni.denik.jooq.enums.Role.INSPECTOR)))
    }

    @Test
    fun `a project has at most 100 active authorized persons, and revoking one makes room`() = runBlocking<Unit> {
        val s = site()
        repeat(PartASnapshot.MAX_PERSONS) { n ->
            dsl.insertInto(AUTHORIZED_PERSONS).set(AUTHORIZED_PERSONS.PROJECTID, s.projectId).set(AUTHORIZED_PERSONS.NAME, "Osoba $n").execute()
        }

        assertThrows<ConflictException> { AuthorizedPersonService.create(s.boss, s.projectId, CreateAuthorizedPersonRequest("Navíc")) }

        val first = dsl.select(AUTHORIZED_PERSONS.ID).from(AUTHORIZED_PERSONS).orderBy(AUTHORIZED_PERSONS.CREATEDAT.asc()).limit(1).fetchOne(AUTHORIZED_PERSONS.ID)!!
        AuthorizedPersonService.revoke(s.boss, first)
        AuthorizedPersonService.create(s.boss, s.projectId, CreateAuthorizedPersonRequest("Navíc"))
        assertEquals(PartASnapshot.MAX_PERSONS + 1, dsl.fetchCount(AUTHORIZED_PERSONS), "the revoked one stays on record")
    }
}
