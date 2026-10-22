package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.HandoverSide
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.SignerNotQualifiedException
import cz.stavebni.denik.domain.StaleVersionException
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVER_SIGNATURES
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Site handover protocols (backlog A3): an act of two parties, one signature each (the contractor's manager, the client's
 * investor or technical supervision), a version on every change and every signature, the content frozen from the first
 * signature, limits on the text.
 */
class SiteHandoverServiceTest : BaseIntegrationTest() {

    private class Site(
        val projectId: UUID,
        val boss: SessionUser,
        val deputy: SessionUser,
        val worker: SessionUser,
        val investor: SessionUser,
        val inspector: SessionUser,
        val admin: SessionUser,
        val outsider: SessionUser,
    )

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS, displayName = "Ing. Karel Dvořák")
        val deputy = createTestUser(role = Role.BOSS, displayName = "Ing. Zdeněk Zástupce", ckaitNumber = "0054321")
        val worker = createTestUser(role = Role.WORKER, displayName = "Petr Dělník")
        val investor = createTestUser(role = Role.INVESTOR, displayName = "Marie Stavebníková")
        val inspector = createTestUser(role = Role.INSPECTOR, displayName = "Ing. Tomáš Dozor")
        val admin = createTestUser(role = Role.BOSS, isAdmin = true, displayName = "Správce")
        val outsider = createTestUser(role = Role.BOSS, displayName = "Cizí Stavbyvedoucí")
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Handover Project", address = "Address", cadastralArea = "Area", parcelNumbers = "1",
                builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        listOf(deputy, worker, investor, inspector).forEach { addMember(projectId, it) }
        return Site(projectId, boss, deputy, worker, investor, inspector, admin, outsider)
    }

    private fun meters() = listOf(MeterState(medium = "Elektřina VT", serialNumber = "EL-01", state = "12450.5 kWh"))

    private fun signatures(id: UUID) = dsl.selectFrom(SITE_HANDOVER_SIGNATURES).where(SITE_HANDOVER_SIGNATURES.HANDOVERID.eq(id)).fetch()

    // --- the life of a protocol --------------------------------------------------------------------

    @Test
    fun `full lifecycle - create, list, get, update, sign by both parties`() = runBlocking<Unit> {
        val s = site()

        val created = SiteHandoverService.createHandover(
            s.boss, s.projectId,
            handoverInput(type = "PROTOCOL_ZACATEK", date = "2026-09-28T09:00:00Z", participants = "Jan Novak, Petr Stavitel", meterStates = meters(), notes = "Prevzeti probehlo bez zavad"),
        )
        assertNotNull(created.id)
        assertEquals("2026-09-28", created.date)

        val fetched = SiteHandoverService.getHandover(dsl, s.boss, created.uuid)!!
        assertEquals("PROTOCOL_ZACATEK", fetched.type)
        assertEquals("12450.5 kWh", fetched.meterStates?.single()?.state)
        val list = SiteHandoverService.listHandovers(dsl, s.boss, s.projectId)
        assertEquals(listOf(created.id), list.map { it.id })

        val updated = SiteHandoverService.updateHandover(s.boss, created.uuid, fetched.asInput(notes = "Aktualizovane poznamky"))
        assertEquals("Aktualizovane poznamky", updated.notes)
        assertNotEquals(created.updatedAt, updated.updatedAt, "a change is a new version")

        val byContractor = signHandover(s.boss, updated)
        assertEquals(SiteHandoverState.SIGNED_BY_CONTRACTOR, byContractor.state)
        val complete = signHandover(s.investor, byContractor)
        assertEquals(SiteHandoverState.COMPLETE, complete.state)
        assertEquals(complete, SiteHandoverService.getHandover(dsl, s.boss, created.uuid), "what was answered is what is stored")
        assertEquals(listOf(complete), SiteHandoverService.listHandovers(dsl, s.investor, s.projectId))
    }

    @Test
    fun `a new protocol is a draft with a version and no signatures`() = runBlocking<Unit> {
        val s = site()

        val created = SiteHandoverService.createHandover(s.worker, s.projectId, handoverInput())

        assertEquals(SiteHandoverState.DRAFT, created.state)
        assertNull(created.contractorSignature)
        assertNull(created.clientSignature)
        assertNotNull(created.updatedAt)
        assertEquals(s.worker.id.toString(), created.createdById)
        assertEquals(0, signatures(created.uuid).size)
    }

    @Test
    fun `an unsigned protocol may be deleted, a protocol that a party signed never`() = runBlocking<Unit> {
        val s = site()
        val unsigned = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())
        SiteHandoverService.deleteHandover(s.boss, unsigned.uuid)
        assertNotNull(dsl.selectFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(unsigned.uuid)).fetchOne()!!.deletedat)
        assertNull(SiteHandoverService.getHandover(dsl, s.boss, unsigned.uuid), "a deleted protocol is gone for the API")

        for ((signer, party) in listOf(s.boss to "the contractor", s.investor to "the client")) {
            val signed = signHandover(signer, SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Podepsaný $party")))
            val failure = assertThrows<ConflictException>("deleting what $party signed") { runBlocking { SiteHandoverService.deleteHandover(s.boss, signed.uuid) } }
            assertTrue(failure.message!!.contains("podeps"), failure.message)
            assertNull(dsl.selectFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(signed.uuid)).fetchOne()!!.deletedat)
        }
    }

    @Test
    fun `a worker may change and delete only the protocol they made, and the manager any unsigned one`() = runBlocking<Unit> {
        val s = site()
        val ofWorker = SiteHandoverService.createHandover(s.worker, s.projectId, handoverInput())
        val ofBoss = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())

        assertEquals("Opraveno", SiteHandoverService.updateHandover(s.worker, ofWorker.uuid, ofWorker.asInput(notes = "Opraveno")).notes)
        assertThrows<ForbiddenException> { runBlocking { SiteHandoverService.updateHandover(s.worker, ofBoss.uuid, ofBoss.asInput(notes = "Cizí")) } }
        assertThrows<ForbiddenException> { runBlocking { SiteHandoverService.deleteHandover(s.worker, ofBoss.uuid) } }
        for (outsider in listOf(s.investor, s.inspector)) {
            assertThrows<ForbiddenException> { runBlocking { SiteHandoverService.updateHandover(outsider, ofBoss.uuid, ofBoss.asInput(notes = "Cizí")) } }
            assertThrows<ForbiddenException> { runBlocking { SiteHandoverService.createHandover(outsider, s.projectId, handoverInput()) } }
        }
        assertEquals("Opraveno ředitelem", SiteHandoverService.updateHandover(s.deputy, ofWorker.uuid, SiteHandoverService.getHandover(dsl, s.deputy, ofWorker.uuid)!!.asInput(notes = "Opraveno ředitelem")).notes)
    }

    // --- who signs, and for whom -------------------------------------------------------------------

    @Test
    fun `the contractor signs as the manager of the project, and the signature says who, in which role, with which number and when`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.worker, s.projectId, handoverInput(participants = "Novák", meterStates = meters(), notes = "Bez vad"))

        val before = OffsetDateTime.now().minusSeconds(1)
        val signed = signHandover(s.deputy, created)

        val signature = signed.contractorSignature!!
        assertNull(signed.clientSignature)
        assertEquals(HandoverSide.CONTRACTOR, signature.side)
        assertEquals(s.deputy.id.toString(), signature.signedById)
        assertEquals("Ing. Zdeněk Zástupce", signature.signerName)
        assertEquals(Role.BOSS, signature.signerRole)
        assertEquals("0054321", signature.signerCkaitNumber)
        assertTrue(OffsetDateTime.parse(signature.signedAt).isAfter(before))
        assertEquals(created.updatedAt, signed.updatedAt, "a signature does not change the content, so it does not change the version")

        val row = signatures(created.uuid).single()
        assertEquals("CONTRACTOR", row.side)
        assertEquals(s.deputy.id, row.signedbyid)
        assertEquals(signature.contentHash, row.contenthash)
        assertEquals(signature.signatureHash, row.signaturehash)
    }

    @Test
    fun `the client signs as an investor or as the technical supervision, and no number is stored`() = runBlocking<Unit> {
        val s = site()
        for ((signer, role) in listOf(s.investor to Role.INVESTOR, s.inspector to Role.INSPECTOR)) {
            val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Předání pro $role"))

            val signed = signHandover(signer, created)

            val signature = signed.clientSignature!!
            assertEquals(SiteHandoverState.SIGNED_BY_CLIENT, signed.state)
            assertNull(signed.contractorSignature)
            assertEquals(HandoverSide.CLIENT, signature.side)
            assertEquals(signer.id.toString(), signature.signedById)
            assertEquals(role, signature.signerRole)
            assertNull(signature.signerCkaitNumber)
        }
    }

    @Test
    fun `both signatures carry the hash of the content, and every hash is what the frozen format says it is`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(
            s.boss, s.projectId,
            handoverInput(type = "Předání", date = "2026-09-28", participants = "Novák; Svoboda", meterStates = meters(), notes = "Staveniště předáno \"bez výhrad\"\nDruhý řádek"),
        )

        val complete = signHandover(s.investor, signHandover(s.boss, created))

        val content = HandoverHash.content(created.id!!, s.projectId.toString(), "Předání", "2026-09-28", "Novák; Svoboda", meters(), "Staveniště předáno \"bez výhrad\"\nDruhý řádek")
        val contentHash = HandoverHash.contentHash(content)
        val contractor = complete.contractorSignature!!
        val client = complete.clientSignature!!
        assertEquals(contentHash, contractor.contentHash, "the contractor signed this content")
        assertEquals(contentHash, client.contentHash, "and so did the client: the same")
        assertEquals(
            HandoverHash.signatureHash(
                HandoverHash.signature(HandoverSide.CONTRACTOR, contentHash, OffsetDateTime.parse(contractor.signedAt), s.boss.id.toString(), "Ing. Karel Dvořák", Role.BOSS, "0012345"),
            ),
            contractor.signatureHash,
        )
        assertEquals(
            HandoverHash.signatureHash(
                HandoverHash.signature(HandoverSide.CLIENT, contentHash, OffsetDateTime.parse(client.signedAt), s.investor.id.toString(), "Marie Stavebníková", Role.INVESTOR, null),
            ),
            client.signatureHash,
        )
        assertNotEquals(contractor.signatureHash, client.signatureHash)
    }

    @Test
    fun `a worker, an administrator who is not a member and a stranger cannot sign, and nothing is written`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())

        for ((who, person) in listOf("a worker" to s.worker, "an administrator who is not a member" to s.admin, "the manager of another project" to s.outsider)) {
            assertThrows<ForbiddenException>("$who signing") { runBlocking { signHandover(person, created) } }
            assertThrows<ForbiddenException>("$who asking whether they may sign") { SiteHandoverService.checkMaySign(person, created.uuid, null) }
        }
        assertEquals(0, signatures(created.uuid).size)
        assertEquals(0, dsl.fetchCount(AUDIT_LOG, AUDIT_LOG.ACTION.eq("siteHandover.sign")))
    }

    @Test
    fun `an administrator who is a member signs for the side of the role they hold in the project, not for being an administrator`() = runBlocking<Unit> {
        val s = site()
        addMember(s.projectId, s.admin, Role.WORKER)
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())
        assertThrows<ForbiddenException> { runBlocking { signHandover(s.admin, created) } }

        addMember(s.projectId, s.admin, Role.INSPECTOR)
        assertEquals(HandoverSide.CLIENT, signHandover(s.admin, created).clientSignature!!.side)
    }

    @Test
    fun `a side that the request names has to be the person's own`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())

        assertThrows<ForbiddenException>("a manager signing for the client") { runBlocking { signHandover(s.boss, created, HandoverSide.CLIENT) } }
        assertThrows<ForbiddenException>("an investor signing for the contractor") { runBlocking { signHandover(s.investor, created, HandoverSide.CONTRACTOR) } }
        assertThrows<ForbiddenException> { SiteHandoverService.checkMaySign(s.boss, created.uuid, HandoverSide.CLIENT) }
        assertEquals(0, signatures(created.uuid).size)

        assertEquals(HandoverSide.CONTRACTOR, SiteHandoverService.checkMaySign(s.boss, created.uuid, HandoverSide.CONTRACTOR))
        assertEquals(HandoverSide.CLIENT, SiteHandoverService.checkMaySign(s.inspector, created.uuid, null), "without a side the role says which")
        assertEquals(HandoverSide.CONTRACTOR, signHandover(s.boss, created, HandoverSide.CONTRACTOR).contractorSignature!!.side)
    }

    @Test
    fun `a manager without a ČKAIT number cannot sign for the contractor, and is told so before the password`() = runBlocking<Unit> {
        val s = site()
        val withoutNumber = createTestUser(role = Role.BOSS, ckaitNumber = null)
        addMember(s.projectId, withoutNumber)
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())

        val refusal = assertThrows<SignerNotQualifiedException> { SiteHandoverService.checkMaySign(withoutNumber, created.uuid, null) }
        assertTrue(refusal.message!!.contains("ČKAIT"), refusal.message)
        assertThrows<SignerNotQualifiedException> { runBlocking { signHandover(withoutNumber, created) } }
        assertEquals(0, signatures(created.uuid).size)

        // The client side has no such requirement.
        assertNotNull(signHandover(s.investor, created).clientSignature)
    }

    @Test
    fun `a side is signed once - another manager and another investor are refused`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())
        val second = createTestUser(role = Role.INVESTOR)
        addMember(s.projectId, second)

        val byContractor = signHandover(s.boss, created)
        assertThrows<ConflictException>("the same person again") { runBlocking { signHandover(s.boss, byContractor) } }
        val other = assertThrows<ConflictException>("another manager") { runBlocking { signHandover(s.deputy, byContractor) } }
        assertTrue(other.message!!.contains("zhotovitel"), other.message)
        assertThrows<ConflictException> { SiteHandoverService.checkMaySign(s.deputy, created.uuid, null) }

        val complete = signHandover(s.investor, byContractor)
        assertThrows<ConflictException>("another investor") { runBlocking { signHandover(second, complete) } }
        assertThrows<ConflictException>("the technical supervision, the client's side being signed") { runBlocking { signHandover(s.inspector, complete) } }
        assertEquals(2, signatures(created.uuid).size)
        assertEquals(s.boss.id, signatures(created.uuid).single { it.side == "CONTRACTOR" }.signedbyid)
    }

    @Test
    fun `one person cannot sign both sides, which could only happen if their role in the project changed in between`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())
        val byContractor = signHandover(s.boss, created)

        addMember(s.projectId, s.boss, Role.INVESTOR)

        val failure = assertThrows<ConflictException> { runBlocking { signHandover(s.boss, byContractor) } }
        assertTrue(failure.message!!.contains("obě strany"), failure.message)
        assertEquals(1, signatures(created.uuid).size)
    }

    // --- the content is frozen from the first signature -------------------------------------------

    @Test
    fun `the content is frozen from the first signature, whichever party signed`() = runBlocking<Unit> {
        val s = site()
        for ((signer, party) in listOf(s.boss to "contractor", s.inspector to "client")) {
            val signed = signHandover(signer, SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Předání ($party)", notes = "Původní")))

            val failure = assertThrows<ConflictException>("a change after the $party signed") {
                runBlocking { SiteHandoverService.updateHandover(s.boss, signed.uuid, signed.asInput(notes = "Přepsané")) }
            }
            assertTrue(failure.message!!.contains("podeps"), failure.message)
            assertEquals("Původní", dsl.selectFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(signed.uuid)).fetchOne()!!.notes)
            assertEquals(1, signatures(signed.uuid).size)
        }
    }

    @Test
    fun `changing a protocol needs the version it was based on, and an old one is refused with nothing changed`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(notes = "Původní"))

        assertThrows<IllegalArgumentException>("no version") { runBlocking { SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(notes = "Bez verze", expectedUpdatedAt = null)) } }
        assertThrows<IllegalArgumentException>("a blank version") { runBlocking { SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(expectedUpdatedAt = "  ")) } }
        assertThrows<IllegalArgumentException>("a version that is not a time") { runBlocking { SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(expectedUpdatedAt = "včera")) } }

        val first = SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(notes = "První"))
        // The second person was looking at the version before the first one's change.
        assertThrows<StaleVersionException> { runBlocking { SiteHandoverService.updateHandover(s.deputy, created.uuid, created.asInput(notes = "Druhý")) } }

        assertEquals("První", SiteHandoverService.getHandover(dsl, s.boss, created.uuid)!!.notes)
        assertEquals(first.updatedAt, SiteHandoverService.getHandover(dsl, s.boss, created.uuid)!!.updatedAt, "the refused change did not even move the version")
        assertEquals("Druhý", SiteHandoverService.updateHandover(s.deputy, created.uuid, first.asInput(notes = "Druhý")).notes, "with the version that is current it goes through")
    }

    @Test
    fun `a signature covers a version - an old one is refused, and the other party's signature does not make the version old`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(notes = "Původní"))
        val seenByInvestor = created
        val changed = SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(notes = "Změněné"))

        // The investor looked at the text before it was changed: they would sign words they never saw.
        assertThrows<StaleVersionException> { runBlocking { signHandover(s.investor, seenByInvestor) } }
        assertEquals(0, signatures(created.uuid).size)

        // The manager signs the version they saw ...
        val byContractor = signHandover(s.boss, changed)
        // ... and the investor, who loaded exactly that version before the manager signed, still signs it: the content did not change.
        val complete = signHandover(s.investor, changed)
        assertEquals(SiteHandoverState.COMPLETE, complete.state)
        assertEquals(byContractor.updatedAt, complete.updatedAt)
        assertEquals(byContractor.contractorSignature!!.contentHash, complete.clientSignature!!.contentHash)
    }

    @Test
    fun `the second party refuses a content that no longer fits what the first one signed`() = runBlocking<Unit> {
        val s = site()
        val created = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(notes = "Původní"))
        val byContractor = signHandover(s.boss, created)

        // The protocol is changed behind the application's back: the triggers are switched off, as only the owner of the table can.
        dsl.execute("""ALTER TABLE "site_handovers" DISABLE TRIGGER USER""")
        try {
            dsl.update(SITE_HANDOVERS).set(SITE_HANDOVERS.NOTES, "Přepsáno").where(SITE_HANDOVERS.ID.eq(created.uuid)).execute()
        } finally {
            dsl.execute("""ALTER TABLE "site_handovers" ENABLE TRIGGER USER""")
        }
        val changed = SiteHandoverService.getHandover(dsl, s.boss, created.uuid)!!

        val failure = assertThrows<ConflictException> { runBlocking { signHandover(s.investor, changed) } }
        assertTrue(failure.message!!.contains("změnil"), failure.message)
        assertEquals(1, signatures(created.uuid).size, "the second signature was not added to a content the first never signed")
        assertEquals(SiteHandoverState.SIGNED_BY_CONTRACTOR, SiteHandoverService.getHandover(dsl, s.boss, created.uuid)!!.state)
        assertNotNull(byContractor)
    }

    // --- the text -----------------------------------------------------------------------------------

    @Test
    fun `the text of a protocol has limits - what is at the limit is kept, one more is a 400 that names the limit`() = runBlocking<Unit> {
        val s = site()
        fun create(input: SiteHandoverInput) = runBlocking { SiteHandoverService.createHandover(s.boss, s.projectId, input) }
        fun refused(what: String, input: SiteHandoverInput, limit: String) {
            val failure = assertThrows<IllegalArgumentException>(what) { create(input) }
            assertTrue(failure.message!!.contains(limit), "$what: ${failure.message}")
        }

        assertEquals(200, create(handoverInput(type = "t".repeat(200))).type.length)
        refused("the type", handoverInput(type = "t".repeat(201)), "200")
        assertEquals(2000, create(handoverInput(participants = "p".repeat(2000))).participants.length)
        refused("the participants", handoverInput(participants = "p".repeat(2001)), "2000")
        assertEquals(5000, create(handoverInput(notes = "n".repeat(5000))).notes!!.length)
        refused("the notes", handoverInput(notes = "n".repeat(5001)), "5000")

        val meter = MeterState("m", "s", "x")
        assertEquals(50, create(handoverInput(meterStates = List(50) { meter })).meterStates!!.size)
        refused("the number of meters", handoverInput(meterStates = List(51) { meter }), "50")
        assertEquals(100, create(handoverInput(meterStates = listOf(MeterState("m".repeat(100), "s".repeat(100), "x".repeat(100))))).meterStates!!.single().state.length)
        refused("a medium", handoverInput(meterStates = listOf(meter.copy(medium = "m".repeat(101)))), "100")
        refused("a serial number", handoverInput(meterStates = listOf(meter.copy(serialNumber = "s".repeat(101)))), "100")
        refused("a state", handoverInput(meterStates = listOf(meter.copy(state = "x".repeat(101)))), "100")

        // Characters as a person counts them: an emoji is one, not two.
        assertEquals(5000, create(handoverInput(notes = "🚧".repeat(5000))).notes!!.codePointCount(0, 10000))
    }

    @Test
    fun `a NUL character is refused wherever it is typed, and a protocol that is refused leaves nothing behind`() = runBlocking<Unit> {
        val s = site()
        val nul = "a\u0000b"
        for ((what, input) in listOf(
            "the type" to handoverInput(type = nul),
            "the participants" to handoverInput(participants = nul),
            "the notes" to handoverInput(notes = nul),
            "a meter" to handoverInput(meterStates = listOf(MeterState(nul, "s", "x"))),
        )) {
            val failure = assertThrows<IllegalArgumentException>(what) { runBlocking { SiteHandoverService.createHandover(s.boss, s.projectId, input) } }
            assertTrue(failure.message!!.contains("NUL"), failure.message)
        }
        assertEquals(0, dsl.fetchCount(SITE_HANDOVERS))
        assertEquals(0, dsl.fetchCount(AUDIT_LOG, AUDIT_LOG.ACTION.like("siteHandover.%")))
    }

    @Test
    fun `the type is required, the text is trimmed and a blank note is none`() = runBlocking<Unit> {
        val s = site()
        assertThrows<IllegalArgumentException> { runBlocking { SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "   ")) } }
        assertThrows<IllegalArgumentException>("a date that is not one") { runBlocking { SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(date = "28.9.2026")) } }

        val created = SiteHandoverService.createHandover(
            s.boss, s.projectId,
            handoverInput(type = "  Předání  ", participants = "  Novák  ", notes = "   ", meterStates = listOf(MeterState("  Voda ", " V-1 ", " 3 m3 "))),
        )

        assertEquals("Předání", created.type)
        assertEquals("Novák", created.participants)
        assertNull(created.notes)
        assertEquals(MeterState("Voda", "V-1", "3 m3"), created.meterStates!!.single())
        val changed = SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(type = "  Nový typ  ", notes = " Poznámka "))
        assertEquals("Nový typ", changed.type, "the same on a change (before, only a new protocol was trimmed)")
        assertEquals("Poznámka", changed.notes)
    }

    // --- reading ---------------------------------------------------------------------------------

    @Test
    fun `the members and an administrator read a protocol with its signatures, a stranger does not`() = runBlocking<Unit> {
        val s = site()
        val signed = signHandover(s.investor, signHandover(s.boss, SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput())))

        for (reader in listOf(s.boss, s.worker, s.investor, s.inspector, s.admin)) {
            assertEquals(signed, SiteHandoverService.getHandover(dsl, reader, signed.uuid), "read by ${reader.displayName}")
            assertEquals(listOf(signed), SiteHandoverService.listHandovers(dsl, reader, s.projectId))
        }
        assertThrows<ForbiddenException> { runBlocking { SiteHandoverService.getHandover(dsl, s.outsider, signed.uuid) } }
        assertThrows<ForbiddenException> { runBlocking { SiteHandoverService.listHandovers(dsl, s.outsider, s.projectId) } }
    }

    @Test
    fun `the list shows the newest day first, with every protocol's own signatures`() = runBlocking<Unit> {
        val s = site()
        val older = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Starší", date = "2026-09-01"))
        val newer = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Novější", date = "2026-09-20"))
        val other = SiteHandoverService.createHandover(s.boss, s.projectId, handoverInput(type = "Prostřední", date = "2026-09-10"))
        signHandover(s.boss, newer)
        signHandover(s.investor, other)
        signHandover(s.boss, other)

        val list = SiteHandoverService.listHandovers(dsl, s.boss, s.projectId)

        assertEquals(listOf("Novější", "Prostřední", "Starší"), list.map { it.type })
        assertEquals(listOf(SiteHandoverState.SIGNED_BY_CONTRACTOR, SiteHandoverState.COMPLETE, SiteHandoverState.DRAFT), list.map { it.state })
        assertEquals(older.id, list.last().id)
    }
}
