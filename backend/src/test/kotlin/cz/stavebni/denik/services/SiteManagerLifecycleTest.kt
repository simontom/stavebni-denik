package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.SESSIONS
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

    // ------------------------------------------------------------------ N5: the current site manager

    private fun openSessions(userId: UUID) = dsl.fetchCount(SESSIONS, SESSIONS.USERID.eq(userId).and(SESSIONS.REVOKEDAT.isNull))

    @Test
    fun `deactivating the current site manager is allowed, ends their sessions and warns, naming the project`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager, name = "Bytový dům Špitálka")
        generateJwtToken(manager) // an open session
        assertEquals(1, openSessions(manager.id))

        val answer = UserService.setActive(actor, manager.id, active = false)

        assertFalse(answer.isActive, "the emergency switch works: a compromised or departed site manager can be switched off")
        assertFalse(stored(manager.id).isactive!!)
        assertEquals(0, openSessions(manager.id))
        assertEquals(1, count("user.deactivate"))
        val warning = answer.warning
        assertNotNull(warning, "but the admin is told what is left behind")
        assertTrue(warning!!.contains("Bytový dům Špitálka"), warning)
        assertTrue(warning.contains("stavbyvedouc") && warning.contains("jiného"), "says to replace the site manager: $warning")
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `the warning of a deactivated manager of several projects names all of them`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager, name = "První stavba")
        project(manager, manager, name = "Druhá stavba")

        val warning = UserService.setActive(actor, manager.id, active = false).warning!!

        assertTrue(warning.contains("První stavba") && warning.contains("Druhá stavba"), warning)
    }

    @Test
    fun `the current site manager cannot be deleted, and the refusal names the project`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager, name = "Rekonstrukce školy")

        val refused = assertThrows<ConflictException> { UserService.deleteUser(actor, manager.id) }

        assertTrue(refused.message!!.contains("Rekonstrukce školy"), refused.message)
        assertTrue(refused.message!!.contains("stavbyvedouc") && refused.message!!.contains("jiného"), "says why and what to do first: ${refused.message}")
        assertNull(stored(manager.id).deletedat, "not deleted")
        assertEquals(0, count("user.delete"), "no row for what did not happen")
    }

    @Test
    fun `a manager of several projects cannot be deleted, with all of them named`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager, name = "První stavba")
        project(manager, manager, name = "Druhá stavba")

        val refused = assertThrows<ConflictException> { UserService.deleteUser(actor, manager.id) }

        assertTrue(refused.message!!.contains("První stavba") && refused.message!!.contains("Druhá stavba"), refused.message)
    }

    @Test
    fun `once the project has another site manager the user is deactivated without a warning and can be deleted`() = runBlocking<Unit> {
        val actor = admin()
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = project(boss, boss)
        addMember(UUID.fromString(created.id), deputy, Role.BOSS)
        assertThrows<ConflictException> { UserService.deleteUser(actor, boss.id) }

        replace(boss, created, deputy)

        val off = UserService.setActive(actor, boss.id, active = false)
        assertFalse(off.isActive)
        assertNull(off.warning, "the project has an active site manager")
        assertEquals(1, count("user.deactivate"))
        // ... and the new site manager is now the one whose deletion is held back.
        assertThrows<ConflictException> { UserService.deleteUser(actor, deputy.id) }

        UserService.setActive(actor, boss.id, active = true)
        UserService.deleteUser(actor, boss.id)
        assertNotNull(stored(boss.id).deletedat)
        assertEquals(1, count("user.delete"))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a manager who is not the site manager is deactivated without a warning`() = runBlocking<Unit> {
        val actor = admin()
        val boss = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val created = project(boss, boss)
        addMember(UUID.fromString(created.id), deputy, Role.BOSS)

        val off = UserService.setActive(actor, deputy.id, active = false)

        assertFalse(off.isActive)
        assertNull(off.warning)
    }

    @Test
    fun `a project that is deleted no longer holds its site manager`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        val created = project(manager, manager)
        dsl.execute("""update projects set "deletedAt" = now() where id = ?""", UUID.fromString(created.id))

        val off = UserService.setActive(actor, manager.id, active = false)
        assertFalse(off.isActive)
        assertNull(off.warning, "no project is left without a site manager")
        UserService.deleteUser(actor, manager.id)
        assertNotNull(stored(manager.id).deletedat)
    }

    @Test
    fun `reactivating a user is not held back and does not warn`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        project(manager, manager)
        UserService.setActive(actor, manager.id, active = false)

        val on = UserService.setActive(actor, manager.id, active = true)

        assertTrue(on.isActive)
        assertNull(on.warning)
    }

    // ------------------------------------------------------------------ the last administrator, who is also a site manager

    @Test
    fun `the last active administrator is protected first, whether or not they are a site manager`() = runBlocking<Unit> {
        val adminA = createTestUser(nickname = "admin_a", role = Role.BOSS, isAdmin = true)
        val adminB = createTestUser(nickname = "admin_b", role = Role.BOSS, isAdmin = true)
        project(adminA, adminA) // the last administrator is also the site manager of a project
        UserService.setActive(adminA, adminB.id, active = false) // adminB manages nothing, so this is not held back
        val rowsBefore = dsl.fetchCount(AUDIT_LOG)

        // adminB's request started while it still was an administrator: only the guards refuse. adminA is the last one.
        val deactivate = assertThrows<IllegalStateException> { UserService.setActive(adminB, adminA.id, active = false) }
        val delete = assertThrows<IllegalStateException> { UserService.deleteUser(adminB, adminA.id) }

        // The guard of the last administrator (an IllegalStateException), not the site manager rule (a ConflictException): it comes first.
        assertTrue(deactivate.message!!.contains("administrátor"), deactivate.message)
        assertTrue(delete.message!!.contains("administrátor"), delete.message)
        assertTrue(stored(adminA.id).isactive!!)
        assertNull(stored(adminA.id).deletedat)
        assertEquals(rowsBefore, dsl.fetchCount(AUDIT_LOG), "the refused changes left no row")
    }

    @Test
    fun `an administrator who is a site manager but not the last administrator is deactivated with the warning and not deleted`() = runBlocking<Unit> {
        val adminA = createTestUser(nickname = "admin_a", role = Role.BOSS, isAdmin = true)
        val adminB = createTestUser(nickname = "admin_b", role = Role.BOSS, isAdmin = true)
        project(adminA, adminA, name = "Stavba administrátora")

        assertThrows<ConflictException> { UserService.deleteUser(adminB, adminA.id) }
        val off = UserService.setActive(adminB, adminA.id, active = false)

        assertFalse(off.isActive)
        assertTrue(off.warning!!.contains("Stavba administrátora"), off.warning)
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
