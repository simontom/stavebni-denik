package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVER_SIGNATURES
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.util.UUID

/**
 * What the DATABASE refuses about a handover protocol and its signatures (V1: the table and its checks, V5: the triggers),
 * with plain SQL and no service in between: a path that forgot to check, or a bug, must still not be able to change what two
 * parties signed, to sign a side twice, or to store a signature that could not exist.
 */
class SiteHandoverSignaturesDbTest : BaseIntegrationTest() {

    private class Site(val projectId: UUID, val boss: SessionUser, val investor: SessionUser, val inspector: SessionUser)

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS)
        val investor = createTestUser(role = Role.INVESTOR)
        val inspector = createTestUser(role = Role.INSPECTOR)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Signatures", address = "Address", cadastralArea = "Area", parcelNumbers = "1",
                builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        addMember(projectId, investor)
        addMember(projectId, inspector)
        return Site(projectId, boss, investor, inspector)
    }

    private fun insertHandover(s: Site): UUID =
        dsl.insertInto(SITE_HANDOVERS)
            .set(SITE_HANDOVERS.PROJECTID, s.projectId)
            .set(SITE_HANDOVERS.TYPE, "PROTOCOL")
            .set(SITE_HANDOVERS.DATE, OffsetDateTime.parse("2026-09-28T00:00:00Z"))
            .set(SITE_HANDOVERS.PARTICIPANTS, "Novák")
            .returning(SITE_HANDOVERS.ID)
            .fetchSingle()
            .id!!

    private val hash = "a".repeat(64)

    private fun sign(
        handoverId: UUID,
        side: String,
        user: SessionUser,
        role: Role,
        ckait: String? = if (role == Role.BOSS) "0012345" else null,
        name: String = "Jméno Příjmení",
        contentHash: String = hash,
        signatureHash: String = hash,
    ) = dsl.insertInto(SITE_HANDOVER_SIGNATURES)
        .set(SITE_HANDOVER_SIGNATURES.HANDOVERID, handoverId)
        .set(SITE_HANDOVER_SIGNATURES.SIDE, side)
        .set(SITE_HANDOVER_SIGNATURES.SIGNEDBYID, user.id)
        .set(SITE_HANDOVER_SIGNATURES.SIGNERNAME, name)
        .set(SITE_HANDOVER_SIGNATURES.SIGNERROLE, cz.stavebni.denik.jooq.enums.Role.valueOf(role.name))
        .set(SITE_HANDOVER_SIGNATURES.SIGNERCKAITNUMBER, ckait)
        .set(SITE_HANDOVER_SIGNATURES.SIGNEDAT, OffsetDateTime.now())
        .set(SITE_HANDOVER_SIGNATURES.CONTENTHASH, contentHash)
        .set(SITE_HANDOVER_SIGNATURES.SIGNATUREHASH, signatureHash)
        .execute()

    private fun contractorSigns(s: Site, id: UUID) = sign(id, "CONTRACTOR", s.boss, Role.BOSS)
    private fun clientSigns(s: Site, id: UUID) = sign(id, "CLIENT", s.investor, Role.INVESTOR)

    private fun notes(id: UUID) = dsl.selectFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(id)).fetchOne()!!.notes

    /** Every way there is to change the protocol row: a content column, the soft delete, the stamp alone, the removal of the row. */
    private fun assertProtocolIsFrozen(id: UUID, author: UUID, why: String) {
        assertThrows<DataAccessException>("a text: $why") { dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "přepsáno").where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException>("the type: $why") { dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.TYPE, "JINÝ").where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException>("the soft delete: $why") { dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.DELETEDAT, OffsetDateTime.now()).where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException>("the version alone: $why") { dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now()).where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException>("the author: $why") { dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.CREATEDBYID, author).where(SITE_HANDOVERS.ID.eq(id)).execute() }
        assertThrows<DataAccessException>("the row itself: $why") { dsl.deleteFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(id)).execute() }
    }

    // --- the protocol ----------------------------------------------------------------------------

    @Test
    fun `a protocol that nobody signed can be changed and removed as before`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)

        dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "před podpisem").where(SITE_HANDOVERS.ID.eq(id)).execute()
        assertEquals("před podpisem", notes(id))
        dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.DELETEDAT, OffsetDateTime.now()).where(SITE_HANDOVERS.ID.eq(id)).execute()
        assertEquals(1, dsl.deleteFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(id)).execute())
    }

    @Test
    fun `from the signature of the contractor on the protocol cannot change at all`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)
        dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "před podpisem").where(SITE_HANDOVERS.ID.eq(id)).execute()

        contractorSigns(s, id)

        assertProtocolIsFrozen(id, s.boss.id, "the contractor signed")
        assertEquals("před podpisem", notes(id))
    }

    @Test
    fun `from the signature of the client on the protocol cannot change at all, either`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)
        dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "před podpisem").where(SITE_HANDOVERS.ID.eq(id)).execute()

        // The technical supervision signs for the client as well as an investor does.
        sign(id, "CLIENT", s.inspector, Role.INSPECTOR)

        assertProtocolIsFrozen(id, s.boss.id, "the client signed")
        assertEquals("před podpisem", notes(id))
    }

    @Test
    fun `the second party can still sign, and then the protocol is complete and as frozen as before`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)

        contractorSigns(s, id)
        clientSigns(s, id)

        assertEquals(2, dsl.fetchCount(SITE_HANDOVER_SIGNATURES, SITE_HANDOVER_SIGNATURES.HANDOVERID.eq(id)))
        assertProtocolIsFrozen(id, s.boss.id, "both signed")
    }

    // --- a signature -----------------------------------------------------------------------------

    @Test
    fun `a signature is written once, and it cannot be changed or removed`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)
        contractorSigns(s, id)

        assertThrows<DataAccessException> { dsl.update(SITE_HANDOVER_SIGNATURES).set(SITE_HANDOVER_SIGNATURES.SIGNERNAME, "Jiný člověk").execute() }
        assertThrows<DataAccessException> { dsl.update(SITE_HANDOVER_SIGNATURES).set(SITE_HANDOVER_SIGNATURES.SIGNATUREHASH, "b".repeat(64)).execute() }
        assertThrows<DataAccessException> { dsl.update(SITE_HANDOVER_SIGNATURES).set(SITE_HANDOVER_SIGNATURES.SIGNEDAT, OffsetDateTime.now().minusDays(1)).execute() }
        assertThrows<DataAccessException> { dsl.update(SITE_HANDOVER_SIGNATURES).set(SITE_HANDOVER_SIGNATURES.SIDE, "CLIENT").execute() }
        assertThrows<DataAccessException> { dsl.deleteFrom(SITE_HANDOVER_SIGNATURES).execute() }
        assertEquals("Jméno Příjmení", dsl.selectFrom(SITE_HANDOVER_SIGNATURES).fetchOne()!!.signername)
    }

    @Test
    fun `only a protocol that has not been deleted can be signed`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)
        dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.DELETEDAT, OffsetDateTime.now()).where(SITE_HANDOVERS.ID.eq(id)).execute()

        assertThrows<DataAccessException> { contractorSigns(s, id) }
        assertEquals(0, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))
    }

    @Test
    fun `each side is signed once, and one person signs only one side`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)
        val otherManager = createTestUser(role = Role.BOSS)
        contractorSigns(s, id)

        assertThrows<DataAccessException>("a second signature of the contractor's side") { sign(id, "CONTRACTOR", otherManager, Role.BOSS) }
        assertThrows<DataAccessException>("the same signature again") { contractorSigns(s, id) }
        // The person who signed for the contractor cannot also sign for the client (their role in the project changed in between).
        assertThrows<DataAccessException>("both sides by one person") { sign(id, "CLIENT", s.boss, Role.INVESTOR) }
        assertEquals(1, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))

        clientSigns(s, id)
        assertThrows<DataAccessException>("a second signature of the client's side") { sign(id, "CLIENT", s.inspector, Role.INSPECTOR) }
        assertEquals(2, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))
    }

    @Test
    fun `the shape of a signature is checked, the contractor is a manager with a number and the client an investor or the supervision`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)

        assertThrows<DataAccessException>("the contractor without a number") { sign(id, "CONTRACTOR", s.boss, Role.BOSS, ckait = null) }
        assertThrows<DataAccessException>("the contractor with a blank number") { sign(id, "CONTRACTOR", s.boss, Role.BOSS, ckait = "   ") }
        assertThrows<DataAccessException>("the contractor who is an investor") { sign(id, "CONTRACTOR", s.investor, Role.INVESTOR, ckait = "0012345") }
        assertThrows<DataAccessException>("the contractor who is a worker") { sign(id, "CONTRACTOR", s.investor, Role.WORKER, ckait = "0012345") }
        assertThrows<DataAccessException>("the client who is a manager") { sign(id, "CLIENT", s.boss, Role.BOSS, ckait = null) }
        assertThrows<DataAccessException>("the client who is a worker") { sign(id, "CLIENT", s.investor, Role.WORKER) }
        assertThrows<DataAccessException>("the client with a number stored") { sign(id, "CLIENT", s.investor, Role.INVESTOR, ckait = "0012345") }
        assertThrows<DataAccessException>("a third side") { sign(id, "WITNESS", s.investor, Role.INVESTOR) }
        assertThrows<DataAccessException>("a blank name") { sign(id, "CLIENT", s.investor, Role.INVESTOR, name = "  ") }
        assertThrows<DataAccessException>("a content hash that is not a hash") { sign(id, "CLIENT", s.investor, Role.INVESTOR, contentHash = "ABC") }
        assertThrows<DataAccessException>("an upper-case hash") { sign(id, "CLIENT", s.investor, Role.INVESTOR, signatureHash = "A".repeat(64)) }
        assertEquals(0, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))

        // And the shapes that are right go in.
        sign(id, "CONTRACTOR", s.boss, Role.BOSS)
        sign(id, "CLIENT", s.inspector, Role.INSPECTOR)
        assertEquals(2, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))
    }

    @Test
    fun `a person who signed cannot be removed from under their signature`() = runBlocking<Unit> {
        val s = site()
        val id = insertHandover(s)
        // The investor is a member only (a manager is also the site manager, which holds the user in place by itself).
        clientSigns(s, id)

        assertThrows<DataAccessException> { dsl.deleteFrom(USERS).where(USERS.ID.eq(s.investor.id)).execute() }
        assertEquals(1, dsl.fetchCount(SITE_HANDOVER_SIGNATURES))
    }
}
