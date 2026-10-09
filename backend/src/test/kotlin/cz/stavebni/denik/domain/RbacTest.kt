package cz.stavebni.denik.domain

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/**
 * The permission matrix. Inside a project everything follows the role the person holds *in that project*
 * ([Resource.role]); the global role of the user only decides who may create projects.
 */
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

    private val boss = Role.BOSS
    private val worker = Role.WORKER
    private val inspector = Role.INSPECTOR
    private val investor = Role.INVESTOR

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
    fun `creating a project is for the global role BOSS only`() {
        assertTrue(can(testUser(Role.BOSS), Action.ProjectCreate))
        assertFalse(can(testUser(Role.WORKER), Action.ProjectCreate))
        assertFalse(can(testUser(Role.INSPECTOR), Action.ProjectCreate))
        assertFalse(can(testUser(Role.INVESTOR), Action.ProjectCreate))
    }

    @Test
    fun `report update permissions follow the project role`() {
        val someone = testUser(role = Role.WORKER)

        assertTrue(can(someone, Action.ReportUpdate, Resource(role = boss)), "a manager corrects any entry")
        assertTrue(can(someone, Action.ReportUpdate, Resource(role = worker, authorId = someone.id)), "a worker their own")
        assertFalse(can(someone, Action.ReportUpdate, Resource(role = worker, authorId = UUID.randomUUID())), "not somebody else's")
        assertFalse(can(someone, Action.ReportUpdate, Resource(role = null)), "a non-member")
        assertFalse(can(someone, Action.ReportUpdate, Resource(role = null, authorId = someone.id)))
        assertFalse(can(someone, Action.ReportUpdate, Resource(role = boss, isLocked = true)), "a signed entry is final")
        assertFalse(can(someone, Action.ReportUpdate, Resource(role = worker, isLocked = true, authorId = someone.id)))
        assertFalse(can(someone, Action.ReportUpdate, Resource(role = inspector, authorId = someone.id)), "an inspector does not write")
    }

    @Test
    fun `the global role is irrelevant inside a project`() {
        // A global BOSS who is only a worker in this project cannot sign here; a global WORKER who manages it can.
        val globalBoss = testUser(role = Role.BOSS)
        val globalWorker = testUser(role = Role.WORKER)

        assertFalse(can(globalBoss, Action.ReportSign, Resource(role = worker)))
        assertFalse(can(globalBoss, Action.ProjectMemberManage, Resource(role = worker)))
        assertFalse(can(globalBoss, Action.PhotoDelete, Resource(role = worker)))

        assertTrue(can(globalWorker, Action.ReportSign, Resource(role = boss)))
        assertTrue(can(globalWorker, Action.ProjectMemberManage, Resource(role = boss)))
        assertTrue(can(globalWorker, Action.PhotoDelete, Resource(role = boss)))
    }

    @Test
    fun `report sign only for the manager of that project`() {
        val someone = testUser()

        assertTrue(can(someone, Action.ReportSign, Resource(role = boss)))
        assertFalse(can(someone, Action.ReportSign, Resource(role = null)))
        assertFalse(can(someone, Action.ReportSign, Resource(role = worker)))
        assertFalse(can(someone, Action.ReportSign, Resource(role = inspector)))
        assertFalse(can(someone, Action.ReportSign, Resource(role = investor)))
    }

    @Test
    fun `a signed report cannot be signed again`() {
        val someone = testUser()

        assertTrue(can(someone, Action.ReportSign, Resource(role = boss, isLocked = false)))
        assertFalse(can(someone, Action.ReportSign, Resource(role = boss, isLocked = true)))
    }

    @Test
    fun `report create needs a writing role in the project, also for app admins`() {
        val adminBoss = testUser(role = Role.BOSS, isAdmin = true)
        val adminWorker = testUser(role = Role.WORKER, isAdmin = true)
        val plain = testUser()

        assertTrue(can(plain, Action.ReportCreate, Resource(role = boss)))
        assertTrue(can(plain, Action.ReportCreate, Resource(role = worker)))

        // being an app admin is not membership
        for (outsider in listOf(plain, adminBoss, adminWorker)) {
            assertFalse(can(outsider, Action.ReportCreate, Resource(role = null)), "${outsider.role} admin=${outsider.isAdmin}")
        }
        // inspectors and investors only read and acknowledge
        assertFalse(can(plain, Action.ReportCreate, Resource(role = inspector)))
        assertFalse(can(plain, Action.ReportCreate, Resource(role = investor)))
    }

    @Test
    fun `report acknowledge only for an inspector or investor of the project`() {
        val someone = testUser()

        assertTrue(can(someone, Action.ReportAcknowledge, Resource(role = inspector)))
        assertTrue(can(someone, Action.ReportAcknowledge, Resource(role = investor)))
        assertFalse(can(someone, Action.ReportAcknowledge, Resource(role = null)))
        assertFalse(can(someone, Action.ReportAcknowledge, Resource(role = boss)))
        assertFalse(can(someone, Action.ReportAcknowledge, Resource(role = worker)))
    }

    @Test
    fun `photo upload permissions`() {
        val someone = testUser()

        assertTrue(can(someone, Action.PhotoUpload, Resource(role = boss)))
        assertTrue(can(someone, Action.PhotoUpload, Resource(role = worker)))

        assertFalse(can(someone, Action.PhotoUpload, Resource(role = boss, isLocked = true)))
        assertFalse(can(someone, Action.PhotoUpload, Resource(role = null)))
        assertFalse(can(someone, Action.PhotoUpload, Resource(role = inspector)))
    }

    @Test
    fun `photo delete permissions`() {
        val someone = testUser()

        assertTrue(can(someone, Action.PhotoDelete, Resource(role = boss)))

        assertFalse(can(someone, Action.PhotoDelete, Resource(role = boss, isLocked = true)))
        assertFalse(can(someone, Action.PhotoDelete, Resource(role = null)))
        assertFalse(can(someone, Action.PhotoDelete, Resource(role = worker)))
    }

    @Test
    fun `visit delete permissions`() {
        val someone = testUser()

        // a manager always
        assertTrue(can(someone, Action.VisitDelete, Resource(role = boss, authorId = UUID.randomUUID())))
        assertTrue(can(someone, Action.VisitDelete, Resource(role = boss, authorId = someone.id)))

        // anyone else only if they wrote it
        assertTrue(can(someone, Action.VisitDelete, Resource(role = worker, authorId = someone.id)))
        assertFalse(can(someone, Action.VisitDelete, Resource(role = worker, authorId = UUID.randomUUID())))

        // a non-member never
        assertFalse(can(someone, Action.VisitDelete, Resource(role = null)))
        assertFalse(can(someone, Action.VisitDelete, Resource(role = null, authorId = someone.id)))
    }

    @Test
    fun `members and authorized persons are managed by the manager of the project or an administrator`() {
        val plain = testUser(role = Role.BOSS)
        val admin = testUser(role = Role.WORKER, isAdmin = true)

        assertTrue(can(plain, Action.ProjectMemberManage, Resource(role = boss)))
        assertFalse(can(plain, Action.ProjectMemberManage, Resource(role = worker)))
        assertFalse(can(plain, Action.ProjectMemberManage, Resource(role = inspector)))
        assertFalse(can(plain, Action.ProjectMemberManage, Resource(role = null)), "a global BOSS who is not in the project")

        // The administrator's way in (decision D1), whatever their own role.
        assertTrue(can(admin, Action.ProjectMemberManage, Resource(role = null)))
        assertTrue(can(admin, Action.ProjectMemberManage, Resource(role = worker)))
    }

    @Test
    fun `changing or deleting a project is for its manager`() {
        val someone = testUser()
        for (action in listOf(Action.ProjectUpdate, Action.ProjectDelete)) {
            assertTrue(can(someone, action, Resource(role = boss)))
            assertFalse(can(someone, action, Resource(role = worker)))
            assertFalse(can(someone, action, Resource(role = null)))
        }
    }

    /**
     * Every project action against every role, with the flags that matter. One table, so that a new action or a changed
     * rule shows up as a visible diff.
     */
    @Test
    fun `permission matrix of the project role`() {
        val someone = testUser()
        fun row(action: Action, locked: Boolean = false, authored: Boolean = false): String =
            listOf(boss, worker, inspector, investor, null).joinToString("") { r ->
                val resource = Resource(role = r, isLocked = locked, authorId = if (authored) someone.id else UUID.randomUUID())
                if (can(someone, action, resource)) "Y" else "-"
            }

        //                                                        boss worker inspector investor outsider
        assertEquals("YY---", row(Action.ReportCreate))
        assertEquals("Y----", row(Action.ReportUpdate))
        assertEquals("YY---", row(Action.ReportUpdate, authored = true))
        assertEquals("-----", row(Action.ReportUpdate, locked = true, authored = true))
        assertEquals("Y----", row(Action.ReportSign))
        assertEquals("--YY-", row(Action.ReportAcknowledge))
        assertEquals("YY---", row(Action.ReportAddendumCreate))
        assertEquals("YY---", row(Action.PhotoUpload))
        assertEquals("Y----", row(Action.PhotoDelete))
        assertEquals("YYYY-", row(Action.RemarkCreate))
        assertEquals("Y----", row(Action.RemarkUpdate))
        assertEquals("YYYY-", row(Action.RemarkUpdate, authored = true))
        assertEquals("YY---", row(Action.MaterialCreate))
        assertEquals("Y----", row(Action.MaterialUpdate))
        assertEquals("YY---", row(Action.MaterialUpdate, authored = true))
        assertEquals("YY---", row(Action.MaterialResolve))
        assertEquals("YYY--", row(Action.VisitCreate))
        assertEquals("Y----", row(Action.VisitDelete))
        assertEquals("YYYY-", row(Action.VisitDelete, authored = true))
        assertEquals("YY---", row(Action.SiteHandoverCreate))
        assertEquals("Y----", row(Action.SiteHandoverUpdate))
        assertEquals("YY---", row(Action.SiteHandoverUpdate, authored = true))
        assertEquals("YYYY-", row(Action.SiteHandoverSign))
        assertEquals("Y----", row(Action.ProjectUpdate))
        assertEquals("Y----", row(Action.ProjectMemberManage))
    }
}
