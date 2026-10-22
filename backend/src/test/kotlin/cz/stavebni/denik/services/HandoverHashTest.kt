package cz.stavebni.denik.services

import cz.stavebni.denik.domain.HandoverSide
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.Role
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.OffsetDateTime

/**
 * Pins what a signature of a handover protocol covers, **format 1**. A signature made today has to verify in ten years whatever
 * the code looks like by then, so the text and the hashes below are stored here, not recomputed by the code under test. They were
 * made by a Python script that does not share a line with the code (`json.dumps(sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` and `hashlib.sha256`, the same way the entry's format 3 is checked by `verify-signature-format-3.py`). If this
 * test fails, a signature that exists somewhere no longer verifies: change the code, not the test, or introduce a format 2.
 */
class HandoverHashTest {

    private val id = "66666666-6666-4666-8666-666666666666"
    private val projectId = "22222222-2222-4222-8222-222222222222"
    private val meters = listOf(
        MeterState(medium = "Elektřina VT", serialNumber = "EL-98765", state = "12450 kWh"),
        MeterState(medium = "Voda studená", serialNumber = "VO-1", state = "310 m3"),
    )

    /** A quotation mark, a line break, a backslash and a character outside the first plane: what a JSON writer can get wrong. */
    private val notes = "Staveniště předáno \"bez výhrad\"\nDruhý řádek, zpětné lomítko \\ a 🚧"

    private fun content(
        type: String = "Předání staveniště zhotoviteli",
        date: String = "2026-09-28",
        participants: String = "Ing. Jan Novák, Ph.D. (stavebník); Petr Svoboda (zhotovitel)",
        meterStates: List<MeterState>? = meters,
        notes: String? = this.notes,
        id: String = this.id,
        projectId: String = this.projectId,
    ) = HandoverHash.content(id, projectId, type, date, participants, meterStates, notes)

    private val contractorAt = OffsetDateTime.parse("2026-09-28T10:15:30.123+00:00")
    private val clientAt = OffsetDateTime.parse("2026-09-29T10:00:00+02:00")

    private val contentText =
        """{"date":"2026-09-28","format":1,"id":"66666666-6666-4666-8666-666666666666","meterStates":[{"medium":"Elektřina VT","serialNumber":"EL-98765","state":"12450 kWh"},{"medium":"Voda studená","serialNumber":"VO-1","state":"310 m3"}],"notes":"Staveniště předáno \"bez výhrad\"\nDruhý řádek, zpětné lomítko \\ a 🚧","participants":"Ing. Jan Novák, Ph.D. (stavebník); Petr Svoboda (zhotovitel)","projectId":"22222222-2222-4222-8222-222222222222","type":"Předání staveniště zhotoviteli"}"""
    private val contentHash = "e8d10fe2eb8346a93b2ffd827508b6bbd582691f2c05978077ff6cf3e9b1dcf4"

    private val contractorText =
        """{"contentSha256":"e8d10fe2eb8346a93b2ffd827508b6bbd582691f2c05978077ff6cf3e9b1dcf4","format":1,"side":"CONTRACTOR","signedAt":"2026-09-28T10:15:30.123Z","signedById":"11111111-1111-4111-8111-111111111111","signerCkaitNumber":"0012345","signerName":"Ing. Karel Dvořák","signerRole":"BOSS"}"""
    private val contractorHash = "ee24e31aca98045b1cdeedea3f95ef0890cb85f5f8b8453381a3c63a32e62e47"

    private val clientText =
        """{"contentSha256":"e8d10fe2eb8346a93b2ffd827508b6bbd582691f2c05978077ff6cf3e9b1dcf4","format":1,"side":"CLIENT","signedAt":"2026-09-29T08:00:00.000Z","signedById":"55555555-5555-4555-8555-555555555555","signerCkaitNumber":null,"signerName":"Marie Nováková","signerRole":"INSPECTOR"}"""
    private val clientHash = "238ff01da01c3d582f775a43633761ef0f64c52814106b68691e4f7ec9da8d38"

    private fun contractorSignature(contentHash: String = this.contentHash) = HandoverHash.signature(
        HandoverSide.CONTRACTOR, contentHash, contractorAt, "11111111-1111-4111-8111-111111111111", "Ing. Karel Dvořák", Role.BOSS, "0012345",
    )

    private fun clientSignature() = HandoverHash.signature(
        HandoverSide.CLIENT, contentHash, clientAt, "55555555-5555-4555-8555-555555555555", "Marie Nováková", Role.INSPECTOR, null,
    )

    @Test
    fun `format 1 means exactly this content, this content hash and these signature hashes`() {
        assertEquals(1, HandoverHash.FORMAT)
        assertEquals(contentText, AuditHash.canonicalJson(content()))
        assertEquals(contentHash, HandoverHash.contentHash(content()))

        assertEquals(contractorText, AuditHash.canonicalJson(contractorSignature()))
        assertEquals(contractorHash, HandoverHash.signatureHash(contractorSignature()))
        // The client's time is given with an offset and written in UTC; a person who is not the contractor has no number (null, not left out).
        assertEquals(clientText, AuditHash.canonicalJson(clientSignature()))
        assertEquals(clientHash, HandoverHash.signatureHash(clientSignature()))
    }

    @Test
    fun `a protocol without meters is the protocol with an empty list of them`() {
        assertEquals(HandoverHash.contentHash(content(meterStates = emptyList())), HandoverHash.contentHash(content(meterStates = null)))
        assertTrue(AuditHash.canonicalJson(content(meterStates = null)).contains(""""meterStates":[]"""))
    }

    @Test
    fun `every part of the content changes the hash, and the order of the meters is part of it`() {
        val base = HandoverHash.contentHash(content())
        val changed = mapOf(
            "type" to content(type = "Předání staveniště zhotoviteli."),
            "date" to content(date = "2026-09-29"),
            "participants" to content(participants = "Petr Svoboda"),
            "notes" to content(notes = "$notes."),
            "no notes" to content(notes = null),
            "a meter state" to content(meterStates = listOf(meters[0].copy(state = "12451 kWh"), meters[1])),
            "a meter serial number" to content(meterStates = listOf(meters[0].copy(serialNumber = "EL-98766"), meters[1])),
            "a meter medium" to content(meterStates = listOf(meters[0].copy(medium = "Elektřina NT"), meters[1])),
            "another meter" to content(meterStates = meters + MeterState("Plyn", "PL-1", "1 m3")),
            "the order of the meters" to content(meterStates = meters.reversed()),
            "the protocol" to content(id = "77777777-7777-4777-8777-777777777777"),
            "the project" to content(projectId = "88888888-8888-4888-8888-888888888888"),
        )
        for ((what, other) in changed) {
            assertNotEquals(base, HandoverHash.contentHash(other), "a change of $what has to change the hash")
        }
        assertEquals(changed.size, changed.values.map { HandoverHash.contentHash(it) }.toSet().size, "and no two changes give the same hash")
    }

    @Test
    fun `a signature hash covers the side, the content, the time, the person, their role and their number`() {
        val base = HandoverHash.signatureHash(contractorSignature())
        val others = mapOf(
            "the content" to HandoverHash.signature(HandoverSide.CONTRACTOR, "0".repeat(64), contractorAt, "11111111-1111-4111-8111-111111111111", "Ing. Karel Dvořák", Role.BOSS, "0012345"),
            "the side" to HandoverHash.signature(HandoverSide.CLIENT, contentHash, contractorAt, "11111111-1111-4111-8111-111111111111", "Ing. Karel Dvořák", Role.BOSS, "0012345"),
            "the time" to HandoverHash.signature(HandoverSide.CONTRACTOR, contentHash, contractorAt.plusNanos(1_000_000), "11111111-1111-4111-8111-111111111111", "Ing. Karel Dvořák", Role.BOSS, "0012345"),
            "the person" to HandoverHash.signature(HandoverSide.CONTRACTOR, contentHash, contractorAt, "22222222-2222-4222-8222-222222222222", "Ing. Karel Dvořák", Role.BOSS, "0012345"),
            "the name" to HandoverHash.signature(HandoverSide.CONTRACTOR, contentHash, contractorAt, "11111111-1111-4111-8111-111111111111", "Karel Dvořák", Role.BOSS, "0012345"),
            "the role" to HandoverHash.signature(HandoverSide.CONTRACTOR, contentHash, contractorAt, "11111111-1111-4111-8111-111111111111", "Ing. Karel Dvořák", Role.INSPECTOR, "0012345"),
            "the number" to HandoverHash.signature(HandoverSide.CONTRACTOR, contentHash, contractorAt, "11111111-1111-4111-8111-111111111111", "Ing. Karel Dvořák", Role.BOSS, "0012346"),
            "no number" to HandoverHash.signature(HandoverSide.CONTRACTOR, contentHash, contractorAt, "11111111-1111-4111-8111-111111111111", "Ing. Karel Dvořák", Role.BOSS, null),
        )
        for ((what, other) in others) {
            assertNotEquals(base, HandoverHash.signatureHash(other), "a change of $what has to change the signature hash")
        }
    }

    @Test
    fun `the time is the time that is stored, in milliseconds and in UTC, whatever offset it came with`() {
        val withOffset = HandoverHash.signature(
            HandoverSide.CONTRACTOR, contentHash, OffsetDateTime.parse("2026-09-28T12:15:30.123+02:00"), "11111111-1111-4111-8111-111111111111",
            "Ing. Karel Dvořák", Role.BOSS, "0012345",
        )
        assertEquals(contractorHash, HandoverHash.signatureHash(withOffset))
    }
}
