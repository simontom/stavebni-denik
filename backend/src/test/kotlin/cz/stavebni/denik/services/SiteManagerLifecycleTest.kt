package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Managers who are gone (backlog A1, N5): a user who is the CURRENT site manager of a project cannot be deactivated or
 * deleted until the project has another one, and a deactivated or deleted manager does not count as "another manager".
 */
class SiteManagerLifecycleTest : BaseIntegrationTest() {

    private fun admin() = createTestUser(nickname = "the_admin", role = Role.BOSS, isAdmin = true)

    private suspend fun project(creator: SessionUser, siteManager: SessionUser, name: String = "Dům"): ProjectDto =
        ProjectService.createProject(
            creator,
            ProjectDto(
                id = "", name = name, address = "Karlova 15", cadastralArea = "Brno", parcelNumbers = "1",
                builder = "Město", contractor = "Stavitel", siteManagerId = siteManager.id.toString(),
            ),
        )

    private fun stored(id: UUID) = dsl.selectFrom(USERS).where(USERS.ID.eq(id)).fetchSingle()

    private fun count(action: String) = dsl.fetchCount(AUDIT_LOG, AUDIT_LOG.ACTION.eq(action))

    private fun replace(boss: SessionUser, p: ProjectDto, newManager: SessionUser) = runBlocking {
        ProjectService.changeSiteManager(boss, UUID.fromString(p.id), SiteManagerChangeRequest(newManager.id.toString(), "Střídání", p.updatedAt))
    }

    // ------------------------------------------------------------------ N5: the current site manager stays

    @Test
    fun `the current site manager cannot be deactivated, and the refusal names the project`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager, name = "Bytový dům Špitálka")

        val refused = assertThrows<ConflictException> { UserService.setActive(actor, manager.id, active = false) }

        assertTrue(refused.message!!.contains("Bytový dům Špitálka"), refused.message)
        assertTrue(refused.message!!.contains("stavbyvedouc"), "says why: ${refused.message}")
        assertTrue(refused.message!!.contains("jiného"), "says what to do first: ${refused.message}")
        assertTrue(stored(manager.id).isactive!!, "still active")
        assertEquals(0, count("user.deactivate"), "no row for what did not happen")
    }

    @Test
    fun `the current site manager cannot be deleted either`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager, name = "Rekonstrukce školy")

        val refused = assertThrows<ConflictException> { UserService.deleteUser(actor, manager.id) }

        assertTrue(refused.message!!.contains("Rekonstrukce školy"), refused.message)
        assertNull(stored(manager.id).deletedat, "not deleted")
        assertEquals(0, count("user.delete"))
    }

    @Test
    fun `a manager of several projects is refused with all of them named`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager, name = "První stavba")
        project(manager, manager, name = "Druhá stavba")

        val refused = assertThrows<ConflictException> { UserService.setActive(actor, manager.id, active = false) }

        assertTrue(refused.message!!.contains("První stavba") && refused.message!!.contains("Druhá stavba"), refused.message)
    }

    @Test
    fun `once the project has another site manager, the user can be deactivated and deleted, and both are audited`() = runBlocking<Unit> {
        val actor = admin()
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = project(boss, boss)
        addMember(UUID.fromString(created.id), deputy, Role.BOSS)
        assertThrows<ConflictException> { UserService.setActive(actor, boss.id, active = false) }

        replace(boss, created, deputy)

        val off = UserService.setActive(actor, boss.id, active = false)
        assertFalse(off.isActive)
        assertEquals(1, count("user.deactivate"))
        // ... and the new site manager is now the one who is held back.
        assertThrows<ConflictException> { UserService.setActive(actor, deputy.id, active = false) }
        assertThrows<ConflictException> { UserService.deleteUser(actor, deputy.id) }

        UserService.setActive(actor, boss.id, active = true)
        UserService.deleteUser(actor, boss.id)
        assertNotNull(stored(boss.id).deletedat)
        assertEquals(1, count("user.delete"))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a member who is a manager but not the site manager can be deactivated`() = runBlocking<Unit> {
        val actor = admin()
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = project(boss, boss)
        addMember(UUID.fromString(created.id), deputy, Role.BOSS)

        assertFalse(UserService.setActive(actor, deputy.id, active = false).isActive)
    }

    @Test
    fun `a project that is deleted no longer holds its site manager`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        val created = project(manager, manager)
        dsl.execute("""update projects set "deletedAt" = now() where id = ?""", UUID.fromString(created.id))

        assertFalse(UserService.setActive(actor, manager.id, active = false).isActive)
    }

    @Test
    fun `reactivating a user is not held back`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager)
        dsl.update(USERS).set(USERS.ISACTIVE, false).where(USERS.ID.eq(manager.id)).execute() // legacy data: deactivated before this rule

        assertTrue(UserService.setActive(actor, manager.id, active = true).isActive)
    }

    @Test
    fun `the last active administrator is still protected, whether or not they manage a project`() = runBlocking<Unit> {
        val adminA = createTestUser(nickname = "admin_a", role = Role.BOSS, isAdmin = true)
        val adminB = createTestUser(nickname = "admin_b", role = Role.BOSS, isAdmin = true)
        project(adminA, adminA)
        UserService.setActive(adminA, adminB.id, active = false) // adminB manages nothing: allowed

        // adminB's request started while it still was an administrator: only the guards refuse. adminA is the last one.
        assertThrows<RuntimeException> { UserService.setActive(adminB, adminA.id, active = false) }
        assertThrows<RuntimeException> { UserService.deleteUser(adminB, adminA.id) }
        assertTrue(stored(adminA.id).isactive!!)
        assertNull(stored(adminA.id).deletedat)
    }

    // ------------------------------------------------------------------ "another manager" means an active one

    private fun deactivate(id: UUID) = dsl.update(USERS).set(USERS.ISACTIVE, false).where(USERS.ID.eq(id)).execute()

    private fun delete(id: UUID) = dsl.update(USERS).set(USERS.ISACTIVE, false).set(USERS.DELETEDAT, OffsetDateTime.now()).where(USERS.ID.eq(id)).execute()

    private fun roleIn(projectId: UUID, user: SessionUser) =
        dsl.select(PROJECT_MEMBERS.ROLE).from(PROJECT_MEMBERS).where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(user.id))).fetchOne(PROJECT_MEMBERS.ROLE)?.name

    @Test
    fun `a deactivated manager does not count as another manager`() = runBlocking<Unit> {
        val admin = admin()
        val siteManager = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val id = UUID.fromString(project(siteManager, siteManager).id)
        addMember(id, deputy, Role.BOSS)
        // The site manager was deactivated by an operator, or before this rule existed.
        deactivate(siteManager.id)

        // Removing or demoting the deputy would leave nobody who can sign.
        assertThrows<ConflictException> { ProjectMemberService.removeMember(admin, id, deputy.id) }
        assertThrows<ConflictException> { ProjectMemberService.addMember(admin, id, AddMemberRequest(deputy.id.toString(), "WORKER")) }
        assertEquals("BOSS", roleIn(id, deputy))
    }

    @Test
    fun `a deleted manager does not count as another manager`() = runBlocking<Unit> {
        val admin = admin()
        val siteManager = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val id = UUID.fromString(project(siteManager, siteManager).id)
        addMember(id, deputy, Role.BOSS)
        delete(siteManager.id)

        assertThrows<ConflictException> { ProjectMemberService.removeMember(admin, id, deputy.id) }
        assertThrows<ConflictException> { ProjectMemberService.addMember(admin, id, AddMemberRequest(deputy.id.toString(), "INSPECTOR")) }
        assertEquals("BOSS", roleIn(id, deputy))
    }

    @Test
    fun `an active manager still counts, so a deputy can be removed while the site manager is active`() = runBlocking<Unit> {
        val admin = admin()
        val siteManager = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val id = UUID.fromString(project(siteManager, siteManager).id)
        addMember(id, deputy, Role.BOSS)

        ProjectMemberService.removeMember(admin, id, deputy.id)

        assertNull(roleIn(id, deputy))
        assertEquals("BOSS", roleIn(id, siteManager))
    }
}
