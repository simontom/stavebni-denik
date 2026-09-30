package cz.stavebni.denik.domain

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.assertThrows
import java.util.UUID

class RbacTest {

    private fun testUser(
        role: Role = Role.BOSS,
        isAdmin: Boolean = false,
    ) = SessionUser(
        id = UUID.randomUUID(),
        nickname = "test",
        displayName = "Test User",
        role = role,
        isAdmin = isAdmin,
        mustChangePwd = false,
        sessionId = UUID.randomUUID(),
    )

    @Test
    fun `admin actions only allowed when isAdmin=true`() {
        val admin = testUser(role = Role.WORKER, isAdmin = true)
        val nonAdmin = testUser(role = Role.BOSS, isAdmin = false)
        
        val adminActions = listOf(
            Action.UserCreate, Action.UserUpdate, Action.UserDeactivate,
            Action.UserActivate, Action.UserDelete, Action.UserPasswordReset,
            Action.AuditRead, Action.AuditVerify
        )

        adminActions.forEach { action ->
            assertTrue(can(admin, action))
            assertFalse(can(nonAdmin, action))
            
            assertDoesNotThrow { assertCan(admin, action) }
            val ex = assertThrows<ForbiddenException> { assertCan(nonAdmin, action) }
            assertEquals(action, ex.action)
        }
    }

    @Test
    fun `project creation only allowed for BOSS role`() {
        val boss = testUser(role = Role.BOSS)
        val worker = testUser(role = Role.WORKER)
        val inspector = testUser(role = Role.INSPECTOR)
        val investor = testUser(role = Role.INVESTOR)

        assertTrue(can(boss, Action.ProjectCreate))
        assertFalse(can(worker, Action.ProjectCreate))
        assertFalse(can(inspector, Action.ProjectCreate))
        assertFalse(can(investor, Action.ProjectCreate))
    }

    @Test
    fun `report update permissions`() {
        val boss = testUser(role = Role.BOSS)
        val worker = testUser(role = Role.WORKER)
        
        // allowed for BOSS member on unlocked report
        assertTrue(can(boss, Action.ReportUpdate, Resource(isMember = true, isLocked = false)))
        
        // allowed for author on unlocked report
        assertTrue(can(worker, Action.ReportUpdate, Resource(isMember = true, isLocked = false, authorId = worker.id)))
        
        // denied for non-member
        assertFalse(can(boss, Action.ReportUpdate, Resource(isMember = false, isLocked = false)))
        assertFalse(can(worker, Action.ReportUpdate, Resource(isMember = false, isLocked = false, authorId = worker.id)))
        
        // denied on locked report
        assertFalse(can(boss, Action.ReportUpdate, Resource(isMember = true, isLocked = true)))
        assertFalse(can(worker, Action.ReportUpdate, Resource(isMember = true, isLocked = true, authorId = worker.id)))
    }

    @Test
    fun `report sign only BOSS member`() {
        val boss = testUser(role = Role.BOSS)
        val worker = testUser(role = Role.WORKER)

        assertTrue(can(boss, Action.ReportSign, Resource(isMember = true)))
        assertFalse(can(boss, Action.ReportSign, Resource(isMember = false)))
        assertFalse(can(worker, Action.ReportSign, Resource(isMember = true)))
    }

    @Test
    fun `report acknowledge only INSPECTOR member`() {
        val inspector = testUser(role = Role.INSPECTOR)
        val boss = testUser(role = Role.BOSS)

        assertTrue(can(inspector, Action.ReportAcknowledge, Resource(isMember = true)))
        assertFalse(can(inspector, Action.ReportAcknowledge, Resource(isMember = false)))
        assertFalse(can(boss, Action.ReportAcknowledge, Resource(isMember = true)))
    }

    @Test
    fun `photo upload permissions`() {
        val boss = testUser(role = Role.BOSS)
        val worker = testUser(role = Role.WORKER)
        val inspector = testUser(role = Role.INSPECTOR)

        // BOSS or WORKER member on unlocked report
        assertTrue(can(boss, Action.PhotoUpload, Resource(isMember = true, isLocked = false)))
        assertTrue(can(worker, Action.PhotoUpload, Resource(isMember = true, isLocked = false)))
        
        // Denied if locked or non-member or wrong role
        assertFalse(can(boss, Action.PhotoUpload, Resource(isMember = true, isLocked = true)))
        assertFalse(can(worker, Action.PhotoUpload, Resource(isMember = false, isLocked = false)))
        assertFalse(can(inspector, Action.PhotoUpload, Resource(isMember = true, isLocked = false)))
    }

    @Test
    fun `photo delete permissions`() {
        val boss = testUser(role = Role.BOSS)
        val worker = testUser(role = Role.WORKER)

        // BOSS member on unlocked report
        assertTrue(can(boss, Action.PhotoDelete, Resource(isMember = true, isLocked = false)))
        
        // Denied if locked, non-member, or non-boss
        assertFalse(can(boss, Action.PhotoDelete, Resource(isMember = true, isLocked = true)))
        assertFalse(can(boss, Action.PhotoDelete, Resource(isMember = false, isLocked = false)))
        assertFalse(can(worker, Action.PhotoDelete, Resource(isMember = true, isLocked = false)))
    }

    @Test
    fun `visit delete permissions`() {
        val boss = testUser(role = Role.BOSS)
        val worker = testUser(role = Role.WORKER)

        // BOSS member always
        assertTrue(can(boss, Action.VisitDelete, Resource(isMember = true, authorId = UUID.randomUUID())))
        assertTrue(can(boss, Action.VisitDelete, Resource(isMember = true, authorId = boss.id)))
        
        // WORKER only if author
        assertTrue(can(worker, Action.VisitDelete, Resource(isMember = true, authorId = worker.id)))
        assertFalse(can(worker, Action.VisitDelete, Resource(isMember = true, authorId = UUID.randomUUID())))
        
        // Denied if non-member
        assertFalse(can(boss, Action.VisitDelete, Resource(isMember = false)))
    }

    @Test
    fun `canAccessProject logic`() {
        val boss = testUser(role = Role.BOSS, isAdmin = false)
        val worker = testUser(role = Role.WORKER, isAdmin = false)
        val inspector = testUser(role = Role.INSPECTOR, isAdmin = false)
        val adminBoss = testUser(role = Role.BOSS, isAdmin = true)

        // BOSS/WORKER/INSPECTOR see member projects
        assertTrue(canAccessProject(boss, true))
        assertTrue(canAccessProject(worker, true))
        assertTrue(canAccessProject(inspector, true))

        assertFalse(canAccessProject(boss, false))
        assertFalse(canAccessProject(worker, false))
        assertFalse(canAccessProject(inspector, false))

        // BOSS with isAdmin sees all
        assertTrue(canAccessProject(adminBoss, true))
        assertTrue(canAccessProject(adminBoss, false))
    }
}
