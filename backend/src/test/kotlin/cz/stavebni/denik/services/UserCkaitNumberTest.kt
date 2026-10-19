package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/**
 * The ČKAIT number of a person may be edited (an authorisation can be revoked or suspended, a number can be mistyped), but
 * the edit warns when the person manages a project, an administrator cannot change their own number, and every change is
 * audited with the number as it was and as it became (decision D2, backlog A1).
 */
class UserCkaitNumberTest : BaseIntegrationTest() {

    private fun admin(nickname: String = "the_admin", ckaitNumber: String? = null) =
        createTestUser(nickname = nickname, role = Role.BOSS, isAdmin = true, ckaitNumber = ckaitNumber)

    private suspend fun project(creator: SessionUser, siteManager: SessionUser, name: String = "Dům"): ProjectDto =
        ProjectService.createProject(
            creator,
            ProjectDto(
                id = "", name = name, address = "Karlova 15", cadastralArea = "Brno", parcelNumbers = "1",
                builder = "Město", contractor = "Stavitel", siteManagerId = siteManager.id.toString(),
            ),
        )

    private fun storedNumber(id: UUID): String? = dsl.selectFrom(USERS).where(USERS.ID.eq(id)).fetchSingle().ckaitnumber

    private fun obj(json: String?): JsonObject? = json?.let { Json.parseToJsonElement(it).jsonObject }

    private fun JsonObject.text(key: String): String? = get(key).let { if (it == null || it is JsonNull) null else it.jsonPrimitive.content }

    private fun updateRows() = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("user.update")).orderBy(AUDIT_LOG.ID.asc()).fetch()

    // ------------------------------------------------------------------ the warning

    @Test
    fun `changing the number of a site manager is allowed and warns, naming the project`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS, ckaitNumber = "0012345")
        project(manager, manager, name = "Bytový dům Špitálka")

        val updated = UserService.updateUser(actor, manager.id, UpdateUserRequest(ckaitNumber = "0099999"))

        assertEquals("0099999", updated.ckaitNumber)
        assertEquals("0099999", storedNumber(manager.id))
        val warning = updated.warning
        assertNotNull(warning, "a site manager signs with this number")
        assertTrue(warning!!.contains("Bytový dům Špitálka"), warning)
        assertTrue(warning.contains("stavbyvedoucím"), warning)
    }

    @Test
    fun `clearing the number of a site manager is allowed and warns that the person cannot sign`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS, ckaitNumber = "0012345")
        project(manager, manager, name = "Rekonstrukce školy")

        val updated = UserService.updateUser(actor, manager.id, UpdateUserRequest(ckaitNumber = "  "))

        assertNull(updated.ckaitNumber)
        assertNull(storedNumber(manager.id), "cleared: an authorisation can be revoked")
        val warning = updated.warning!!
        assertTrue(warning.contains("Rekonstrukce školy"), warning)
        assertTrue(warning.contains("podepisovat"), "says what it means: $warning")
        assertEquals(1, dsl.fetchCount(PROJECT_MEMBERS), "the person stays a member of the project")
    }

    @Test
    fun `a manager who is not the site manager of a project warns too, and all their projects are named`() = runBlocking<Unit> {
        val actor = admin()
        val creator = createTestUser(role = Role.BOSS)
        val deputy = createTestUser(role = Role.BOSS)
        val first = project(creator, creator, name = "První stavba")
        addMember(UUID.fromString(first.id), deputy, Role.BOSS)
        project(deputy, deputy, name = "Druhá stavba") // and the site manager of another one

        val updated = UserService.updateUser(actor, deputy.id, UpdateUserRequest(ckaitNumber = "0077777"))

        val warning = updated.warning!!
        assertTrue(warning.contains("První stavba") && warning.contains("Druhá stavba"), warning)
    }

    @Test
    fun `a person who manages nothing is not warned, whether or not they belong to a project`() = runBlocking<Unit> {
        val actor = admin()
        val creator = createTestUser(role = Role.BOSS)
        val worker = createTestUser(role = Role.WORKER, ckaitNumber = "0012300")
        val inspector = createTestUser(role = Role.INSPECTOR, ckaitNumber = "0012301")
        val loner = createTestUser(role = Role.BOSS, ckaitNumber = "0012302")
        val p = project(creator, creator)
        addMember(UUID.fromString(p.id), worker, Role.WORKER)
        addMember(UUID.fromString(p.id), inspector, Role.INSPECTOR)

        for (person in listOf(worker, inspector, loner)) {
            val updated = UserService.updateUser(actor, person.id, UpdateUserRequest(ckaitNumber = "0000042"))
            assertNull(updated.warning, "${person.role} manages no project")
            assertEquals("0000042", storedNumber(person.id))
        }
    }

    @Test
    fun `a project that has been deleted does not warn`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS)
        val p = project(manager, manager)
        dsl.execute("""update projects set "deletedAt" = now() where id = ?""", UUID.fromString(p.id))

        assertNull(UserService.updateUser(actor, manager.id, UpdateUserRequest(ckaitNumber = "0099999")).warning)
    }

    @Test
    fun `an edit that leaves the number as it is does not warn, however often the form sends it`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS, ckaitNumber = "0012345", displayName = "Stará Jména")
        project(manager, manager)

        // The admin screen sends the number along with every edit, also when only the name was corrected.
        val updated = UserService.updateUser(actor, manager.id, UpdateUserRequest(displayName = "Nová Jména", ckaitNumber = "0012345"))
        val padded = UserService.updateUser(actor, manager.id, UpdateUserRequest(ckaitNumber = " 0012345 "))
        val absent = UserService.updateUser(actor, manager.id, UpdateUserRequest(displayName = "Ještě Jinak"))

        assertEquals("Nová Jména", updated.displayName)
        assertNull(updated.warning)
        assertNull(padded.warning, "trimmed, it is the same number")
        assertNull(absent.warning, "an absent number leaves it alone")
        assertEquals("0012345", storedNumber(manager.id))
    }

    // ------------------------------------------------------------------ an administrator and their own number

    @Test
    fun `an administrator cannot change, give themselves or clear their own number`() = runBlocking<Unit> {
        val withNumber = admin(nickname = "has_number", ckaitNumber = "0012345")
        val withoutNumber = admin(nickname = "has_none", ckaitNumber = null)
        val before = dsl.fetchCount(AUDIT_LOG)

        val changed = assertThrows<ConflictException> { UserService.updateUser(withNumber, withNumber.id, UpdateUserRequest(ckaitNumber = "0099999")) }
        assertThrows<ConflictException>("cleared") { runBlocking { UserService.updateUser(withNumber, withNumber.id, UpdateUserRequest(ckaitNumber = "")) } }
        assertThrows<ConflictException>("given") { runBlocking { UserService.updateUser(withoutNumber, withoutNumber.id, UpdateUserRequest(ckaitNumber = "0000001")) } }

        assertTrue(changed.message!!.contains("ČKAIT"), "says what and why: ${changed.message}")
        assertEquals("0012345", storedNumber(withNumber.id))
        assertNull(storedNumber(withoutNumber.id), "an administrator cannot certify themselves as qualified")
        assertEquals(before, dsl.fetchCount(AUDIT_LOG), "a refused change leaves no audit row")
    }

    @Test
    fun `an administrator can still edit their own name, and send their number back unchanged`() = runBlocking<Unit> {
        val withNumber = admin(nickname = "has_number", ckaitNumber = "0012345")
        val withoutNumber = admin(nickname = "has_none", ckaitNumber = null)

        val first = UserService.updateUser(withNumber, withNumber.id, UpdateUserRequest(displayName = "Nové Jméno", ckaitNumber = "0012345"))
        val second = UserService.updateUser(withoutNumber, withoutNumber.id, UpdateUserRequest(displayName = "Jiné Jméno", ckaitNumber = ""))
        val third = UserService.updateUser(withNumber, withNumber.id, UpdateUserRequest(displayName = "Třetí Jméno"))

        assertEquals("Nové Jméno", first.displayName)
        assertEquals("Jiné Jméno", second.displayName)
        assertEquals("Třetí Jméno", third.displayName)
        assertEquals("0012345", storedNumber(withNumber.id))
        assertNull(storedNumber(withoutNumber.id))
    }

    @Test
    fun `an administrator may set the number of somebody else, and another administrator may set theirs`() = runBlocking<Unit> {
        val adminA = admin(nickname = "admin_a")
        val adminB = admin(nickname = "admin_b")
        val worker = createTestUser(role = Role.WORKER, ckaitNumber = null)

        UserService.updateUser(adminA, worker.id, UpdateUserRequest(ckaitNumber = "0000100"))
        UserService.updateUser(adminA, adminB.id, UpdateUserRequest(ckaitNumber = "0000200"))
        UserService.updateUser(adminB, adminA.id, UpdateUserRequest(ckaitNumber = "0000300"))

        assertEquals("0000100", storedNumber(worker.id))
        assertEquals("0000200", storedNumber(adminB.id))
        assertEquals("0000300", storedNumber(adminA.id))
    }

    // ------------------------------------------------------------------ the audit row

    @Test
    fun `every change of the number is one audit row with the number before and after`() = runBlocking<Unit> {
        val actor = admin()
        val person = createTestUser(role = Role.BOSS, ckaitNumber = "0012345")

        UserService.updateUser(actor, person.id, UpdateUserRequest(ckaitNumber = "0099999")) // mistyped, corrected
        UserService.updateUser(actor, person.id, UpdateUserRequest(ckaitNumber = null, displayName = "Jiné Jméno")) // not a change of the number
        UserService.updateUser(actor, person.id, UpdateUserRequest(ckaitNumber = "")) // authorisation revoked
        UserService.updateUser(actor, person.id, UpdateUserRequest(ckaitNumber = "0055555")) // reinstated

        val rows = updateRows()
        assertEquals(4, rows.size, "one row for each edit")
        val numbers = rows.map { obj(it.auditBeforeText())!!.text("ckaitNumber") to obj(it.auditAfterText())!!.text("ckaitNumber") }
        assertEquals(
            listOf("0012345" to "0099999", "0099999" to "0099999", "0099999" to null, null to "0055555"),
            numbers,
        )
        for (row in rows) {
            assertEquals(person.id.toString(), row.get(AUDIT_LOG.ENTITY_ID))
            assertEquals(actor.id.toString(), row.get(AUDIT_LOG.ACTOR_ID))
        }
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `the warning is an answer to the editor, it is not written to the audit row`() = runBlocking<Unit> {
        val actor = admin()
        val manager = createTestUser(role = Role.BOSS, ckaitNumber = "0012345")
        project(manager, manager, name = "Stavba pod dohledem")

        val updated = UserService.updateUser(actor, manager.id, UpdateUserRequest(ckaitNumber = "0099999"))

        assertNotNull(updated.warning)
        val row = updateRows().single()
        assertFalse(row.formatJSON().contains("Stavba pod dohledem"), "the audit row holds the user, not the notice")
    }
}
