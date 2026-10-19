package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Decision D2 when a project is created: the site manager it names is an existing, active user who holds a ČKAIT number, and
 * is added to the project as its manager (BOSS), whatever their account role says. Every refusal is a 409 that says why.
 */
class ProjectCreationManagerTest : BaseIntegrationTest() {

    private fun request(siteManager: UUID) = ProjectDto(
        id = "", name = "Dům", address = "Karlova 15", cadastralArea = "Brno", parcelNumbers = "1",
        builder = "Město", contractor = "Stavitel", siteManagerId = siteManager.toString(),
    )

    private fun roleIn(projectId: String, userId: UUID): String? =
        dsl.select(PROJECT_MEMBERS.ROLE).from(PROJECT_MEMBERS)
            .where(PROJECT_MEMBERS.PROJECTID.eq(UUID.fromString(projectId)).and(PROJECT_MEMBERS.USERID.eq(userId)))
            .fetchOne(PROJECT_MEMBERS.ROLE)?.name

    /** Creating the project is refused with a 409 that says [mustSay], and nothing was created or recorded. */
    private fun assertRefused(creator: cz.stavebni.denik.domain.SessionUser, siteManager: UUID, vararg mustSay: String) {
        val refused = assertThrows<ConflictException> { runBlocking { ProjectService.createProject(creator, request(siteManager)) } }
        for (word in mustSay) assertTrue(refused.message!!.contains(word), "the message says '$word': ${refused.message}")
        assertEquals(0, dsl.fetchCount(PROJECTS), "no project")
        assertEquals(0, dsl.fetchCount(PROJECT_MEMBERS), "no member")
        assertEquals(0, dsl.fetchCount(AUDIT_LOG), "no audit row for what did not happen")
    }

    // ------------------------------------------------------------------ who may be named

    @Test
    fun `a site manager without a ckait number is refused with a conflict`() {
        val creator = createTestUser(role = Role.BOSS)
        val without = createTestUser(role = Role.BOSS, ckaitNumber = null)
        val blank = createTestUser(role = Role.BOSS, ckaitNumber = "   ")

        // Only an administrator can add the number: the message says so instead of sending the creator to an account they cannot edit.
        assertRefused(creator, without.id, "ČKAIT", "administrátor")
        assertRefused(creator, blank.id, "ČKAIT", "administrátor")
    }

    @Test
    fun `a deactivated site manager is refused with a conflict`() {
        val creator = createTestUser(role = Role.BOSS)
        val away = createTestUser(role = Role.BOSS)
        dsl.update(USERS).set(USERS.ISACTIVE, false).where(USERS.ID.eq(away.id)).execute()

        assertRefused(creator, away.id, "deaktivovaný")
    }

    @Test
    fun `a deleted site manager is refused with a conflict`() {
        val creator = createTestUser(role = Role.BOSS)
        val gone = createTestUser(role = Role.BOSS)
        // A deleted user is also inactive (UserService.deleteUser sets both): check the deletion on its own as well.
        dsl.update(USERS).set(USERS.DELETEDAT, OffsetDateTime.now()).where(USERS.ID.eq(gone.id)).execute()

        assertRefused(creator, gone.id, "smazaný")
    }

    @Test
    fun `an unknown site manager is refused with a conflict`() {
        val creator = createTestUser(role = Role.BOSS)

        assertRefused(creator, UUID.randomUUID(), "neexistuje")
    }

    @Test
    fun `a creator without a ckait number is refused with a conflict, not a bad request`() {
        val creator = createTestUser(role = Role.BOSS, ckaitNumber = null)
        val qualified = createTestUser(role = Role.BOSS)

        // The creator becomes a manager of the project and has to hold a number just like the site manager.
        assertRefused(creator, qualified.id, "Zakladatel", "ČKAIT", "administrátor")
    }

    // ------------------------------------------------------------------ who is added, and as what

    @Test
    fun `the site manager is added as a manager of the project even when their account says worker`() = runBlocking<Unit> {
        val creator = createTestUser(role = Role.BOSS)
        // A global worker who holds a ČKAIT number: signing needs the number and the role in the project, not the global role.
        val manager = createTestUser(role = Role.WORKER, ckaitNumber = "0054321")

        val created = ProjectService.createProject(creator, request(manager.id))

        assertEquals(manager.id.toString(), created.siteManagerId)
        assertEquals("BOSS", roleIn(created.id, manager.id), "added as BOSS, not with the role of the account")
        assertEquals("BOSS", roleIn(created.id, creator.id))
        val addedBy = dsl.select(PROJECT_MEMBERS.ADDEDBYID).from(PROJECT_MEMBERS)
            .where(PROJECT_MEMBERS.PROJECTID.eq(UUID.fromString(created.id)).and(PROJECT_MEMBERS.USERID.eq(manager.id)))
            .fetchSingle(PROJECT_MEMBERS.ADDEDBYID)
        assertEquals(creator.id, addedBy)
        val row = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("project.create")).fetchSingle()
        assertEquals(manager.id.toString(), Json.parseToJsonElement(row.get(AUDIT_LOG.AFTER)!!.data()).jsonObject["siteManagerId"]!!.jsonPrimitive.content)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    // ------------------------------------------------------------------ the grants are in the audit chain

    private fun auditRows() = dsl.selectFrom(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch()

    private fun memberRowOf(row: org.jooq.Record): Triple<String?, String?, String?> {
        val before = row.get(AUDIT_LOG.BEFORE)?.data()
        val after = Json.parseToJsonElement(row.get(AUDIT_LOG.AFTER)!!.data()).jsonObject
        return Triple(before, after["userId"]!!.jsonPrimitive.content, after["role"]!!.jsonPrimitive.content)
    }

    @Test
    fun `the signing right given to the site manager at creation is an audit row of its own, as is the creator's`() = runBlocking<Unit> {
        val creator = createTestUser(role = Role.BOSS)
        val manager = createTestUser(role = Role.WORKER, ckaitNumber = "0054321")

        val created = ProjectService.createProject(creator, request(manager.id))

        val rows = auditRows()
        assertEquals(listOf("project.create", "project.member.add", "project.member.add"), rows.map { it.get(AUDIT_LOG.ACTION) })
        val granted = rows.filter { it.get(AUDIT_LOG.ACTION) == "project.member.add" }
        for (row in granted) {
            assertEquals("project", row.get(AUDIT_LOG.ENTITY_TYPE))
            assertEquals(created.id, row.get(AUDIT_LOG.ENTITY_ID), "names the project, as ProjectMemberService.addMember does")
            assertEquals(creator.id.toString(), row.get(AUDIT_LOG.ACTOR_ID))
        }
        // The shape of addMember: no 'before' (they were not members), 'after' is the user and the role.
        assertEquals(
            setOf(Triple(null, creator.id.toString(), "BOSS"), Triple(null, manager.id.toString(), "BOSS")),
            granted.map { memberRowOf(it) }.toSet(),
        )
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a creator who names themselves has one member row, not two`() = runBlocking<Unit> {
        val creator = createTestUser(role = Role.BOSS)

        val created = ProjectService.createProject(creator, request(creator.id))

        val rows = auditRows()
        assertEquals(listOf("project.create", "project.member.add"), rows.map { it.get(AUDIT_LOG.ACTION) })
        assertEquals(Triple(null, creator.id.toString(), "BOSS"), memberRowOf(rows.last()))
        assertEquals(created.id, rows.last().get(AUDIT_LOG.ENTITY_ID))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a creator who names themselves is one manager member`() = runBlocking<Unit> {
        val creator = createTestUser(role = Role.BOSS)

        val created = ProjectService.createProject(creator, request(creator.id))

        assertEquals("BOSS", roleIn(created.id, creator.id))
        assertEquals(1, dsl.fetchCount(PROJECT_MEMBERS, PROJECT_MEMBERS.PROJECTID.eq(UUID.fromString(created.id))))
    }

    @Test
    fun `no other manager can demote or remove a site manager named at creation, so nobody can be left unable to sign`() = runBlocking<Unit> {
        val creator = createTestUser(role = Role.BOSS)
        val manager = createTestUser(role = Role.WORKER, ckaitNumber = "0054321")
        val created = ProjectService.createProject(creator, request(manager.id))
        val projectId = UUID.fromString(created.id)

        // The project's other manager (the creator) tries to push the site manager down or out.
        assertThrows<ConflictException> { runBlocking { ProjectMemberService.addMember(creator, projectId, AddMemberRequest(manager.id.toString(), "WORKER")) } }
        assertThrows<ConflictException> { runBlocking { ProjectMemberService.removeMember(creator, projectId, manager.id) } }

        assertEquals("BOSS", roleIn(created.id, manager.id))
    }
}
