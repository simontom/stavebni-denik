package cz.stavebni.denik.services

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.util.UUID

class AuditHashTest {

    // --- version 1: frozen ------------------------------------------------------------------------------------------------

    @Test
    fun `version 1 row hash is byte-compatible with the original TypeScript canonical scheme`() {
        // Golden value produced by src/server/audit-hash.ts (computeRowHash) for the same payload.
        // Version 1 is frozen: rows written under it keep verifying and anchors name them. This value must never change.
        val after = Json.parseToJsonElement("""{"b":1,"a":"x\"y\n\u0001č"}""")
        val hash = AuditHash.rowHashV1(
            action = "user.create",
            entityType = "user",
            entityId = "novy.delnik",
            actorId = "11111111-1111-1111-1111-111111111111",
            before = null,
            after = after,
            ip = null,
            userAgent = null,
            prevHash = AuditHash.GENESIS_HASH,
            ts = OffsetDateTime.parse("2026-09-30T12:34:56.789Z"),
        )
        assertEquals("c628aca1e82f81309993defd1fa6e497068be7704474704a9886297e3eb9eab2", hash)
    }

    @Test
    fun `timestamps are hashed in UTC with millisecond precision`() {
        assertEquals("2026-09-30T10:34:56.789Z", AuditHash.formatTs(OffsetDateTime.parse("2026-09-30T12:34:56.789+02:00")))
        assertEquals("2026-09-30T12:34:56.000Z", AuditHash.formatTs(OffsetDateTime.parse("2026-09-30T12:34:56Z")))
    }

    // --- version 2: golden vectors ----------------------------------------------------------------------------------------

    /**
     * Pinned inputs and outputs of version 2. They were computed by an independent implementation (a few lines of node's
     * `crypto`, written from the specification in `PROJECT.md`, not from this code), so a verifier written in another language
     * from that specification must produce exactly these values. A change here is a change of the format: it breaks every
     * row already written, and every stub already handed over.
     */
    private object Golden {
        const val SALT_A = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        val PROJECT_A: UUID = UUID.fromString("01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0e")
        const val PAYLOAD_A =
            """{"action":"report.lock","actorId":"11111111-1111-1111-1111-111111111111","after":{"id":"r1","projectId":"01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0e","quantity":12.0,"signatureHash":"ab12","tiny":1e-7,"workDescription":"Betonáž stropu č. 3"},"before":null,"entityId":"r1","entityType":"report","ts":"2026-10-18T09:30:15.123Z"}"""
        const val DIGEST_A = "b2fd3999670b54d54a5b0e29f67b139de31f5c8090a42e745d09121e3a922940"
        const val HASH_A = "8715bd426e2fbbe70d6c5551bcf3a575e45a24559f5fc35ebccd7ce807af4cb7"

        // A row that belongs to no project (a user), chained after row A.
        const val SALT_B = "fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0"
        const val PAYLOAD_B =
            """{"action":"user.update","actorId":null,"after":{"role":"BOSS"},"before":{"role":"WORKER"},"entityId":"22222222-2222-2222-2222-222222222222","entityType":"user","ts":"2026-10-18T09:31:00.000Z"}"""
        const val DIGEST_B = "1fd515d8d8c20e58c08bfcb855f1c902fa5dbcb8d75ce5fbe7692b4925e66239"
        const val HASH_B = "12d38742fca3493ddf0c875fb6fe037686c841253bd616948ce47c96b85b7b66"
    }

    @Test
    fun `version 2 golden vector of a row of a project`() {
        assertEquals(Golden.DIGEST_A, AuditHash.payloadDigestV2(Golden.SALT_A, Golden.PAYLOAD_A))
        assertEquals(Golden.HASH_A, AuditHash.rowHashV2(AuditHash.GENESIS_HASH, Golden.PROJECT_A, Golden.DIGEST_A))
    }

    @Test
    fun `version 2 golden vector of a row that belongs to no project`() {
        assertEquals(Golden.DIGEST_B, AuditHash.payloadDigestV2(Golden.SALT_B, Golden.PAYLOAD_B))
        assertEquals(Golden.HASH_B, AuditHash.rowHashV2(Golden.HASH_A, null, Golden.DIGEST_B))
    }

    @Test
    fun `version 2 payload is the canonical text that the golden vector hashes, numbers and letters exactly as written`() {
        // Keys are sorted at every level; 12.0 and 1e-7 are kept as written (jsonb would have changed the second, JavaScript
        // the first: backlog M10); letters with diacritics are written as they are, not as escapes.
        val after = Json.parseToJsonElement(
            """{"workDescription":"Betonáž stropu č. 3","tiny":1e-7,"signatureHash":"ab12","quantity":12.0,"projectId":"01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0e","id":"r1"}""",
        )
        val text = AuditHash.payloadV2(
            action = "report.lock",
            actorId = "11111111-1111-1111-1111-111111111111",
            entityType = "report",
            entityId = "r1",
            before = null,
            after = after,
            ts = OffsetDateTime.parse("2026-10-18T11:30:15.123+02:00"),
        )
        assertEquals(Golden.PAYLOAD_A, text)

        val user = AuditHash.payloadV2(
            action = "user.update", actorId = null, entityType = "user", entityId = "22222222-2222-2222-2222-222222222222",
            before = Json.parseToJsonElement("""{"role":"WORKER"}"""), after = Json.parseToJsonElement("""{"role":"BOSS"}"""),
            ts = OffsetDateTime.parse("2026-10-18T09:31:00Z"),
        )
        assertEquals(Golden.PAYLOAD_B, user)
    }

    @Test
    fun `a payload reads back as the snapshots it was made from, escapes and nesting included`() {
        val after = Json.parseToJsonElement(
            """{"s":"quote \" backslash \\ newline \n tab \t control \u0001 č ž 😀","a":[1,[2,{"z":null,"y":false}]],"e":{},"empty":""}""",
        )
        val before = Json.parseToJsonElement("""{"n":-1,"f":0.5,"big":123456789012345678901234567890,"t":true}""")
        val text = AuditHash.payloadV2("a.b", null, "user", "id\"1", before, after, OffsetDateTime.parse("2026-10-18T09:31:00Z"))

        val parsed = Json.parseToJsonElement(text).jsonObject
        assertEquals(after, parsed["after"])
        assertEquals(before, parsed["before"])
        assertEquals("id\"1", parsed["entityId"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, parsed["actorId"])
        assertTrue(text.contains(""""big":123456789012345678901234567890"""), "a number that does not fit a double is not rounded")
        assertFalse(text.contains("\": ") || text.contains(", \""), "compact: no layout whitespace between the parts")
    }

    @Test
    fun `a literal that is not JSON is refused instead of written into the payload`() {
        val injected = buildJsonObject { put("n", JsonUnquotedLiteral("""1,"action":"x"""")) }
        assertThrows<IllegalArgumentException> {
            AuditHash.payloadV2("a", null, "user", "1", null, injected, OffsetDateTime.parse("2026-10-18T09:31:00Z"))
        }
    }

    @Test
    fun `a payload with a character that has no UTF-8 form is stored as what is hashed`() {
        // A lone surrogate cannot be written as UTF-8: the encoder would turn it into '?' when hashing and the database
        // driver might do something else when storing. The text is normalised once, so both see the same bytes.
        val text = AuditHash.payloadV2(
            action = "a", actorId = null, entityType = "user", entityId = "x\uD800y",
            before = null, after = null, ts = OffsetDateTime.parse("2026-10-18T09:31:00Z"),
        )
        assertEquals(text, String(text.toByteArray(Charsets.UTF_8), Charsets.UTF_8), "the text survives encoding and decoding unchanged")
        assertTrue(text.contains("x?y"))
    }

    // --- version 2: what a stub is ----------------------------------------------------------------------------------------

    @Test
    fun `a stub carries everything needed to recompute the row hash and nothing of the payload`() {
        // The row hash is a function of three things only: where the row sits in the chain (prev_hash), which project it
        // belongs to, and the digest of what it says. A recipient of a stub has exactly these.
        val digest = AuditHash.payloadDigestV2(Golden.SALT_A, Golden.PAYLOAD_A)
        val fromTheWholeRow = AuditHash.rowHashV2(AuditHash.GENESIS_HASH, Golden.PROJECT_A, AuditHash.payloadDigestV2(Golden.SALT_A, Golden.PAYLOAD_A))
        val fromTheStub = AuditHash.rowHashV2(AuditHash.GENESIS_HASH, Golden.PROJECT_A, digest)
        assertEquals(fromTheWholeRow, fromTheStub)
        assertEquals(Golden.HASH_A, fromTheStub)
    }

    @Test
    fun `without the salt a guess about the payload cannot be confirmed from the digest`() {
        // What a recipient could do with a stub if the digest were not salted: hash a guess and compare.
        val guess = Golden.PAYLOAD_A
        val unsalted = AuditHash.sha256Hex(guess)
        assertNotEquals(Golden.DIGEST_A, unsalted)
        // And the same text under another salt gives an unrelated digest: the digest of a row says nothing about another row.
        assertNotEquals(Golden.DIGEST_A, AuditHash.payloadDigestV2(Golden.SALT_B, Golden.PAYLOAD_A))
    }

    @Test
    fun `a new salt is 32 random bytes as lower-case hex and is never reused`() {
        val salts = (1..50).map { AuditHash.newSalt() }
        assertTrue(salts.all { Regex("[0-9a-f]{64}").matches(it) }, "64 lower-case hex characters")
        assertEquals(50, salts.toSet().size, "every salt is new")
    }

    // --- version 2: nothing can be changed without changing the hash ------------------------------------------------------

    @Test
    fun `every part of a version 2 row changes its hash`() {
        val base = AuditHash.rowHashV2(Golden.HASH_B, Golden.PROJECT_A, Golden.DIGEST_A)
        val otherProject = UUID.fromString("01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0f")
        val flippedDigest = Golden.DIGEST_A.replaceRange(0, 1, if (Golden.DIGEST_A[0] == '0') "1" else "0")
        val flippedPrev = Golden.HASH_B.replaceRange(63, 64, if (Golden.HASH_B[63] == '0') "1" else "0")

        assertNotEquals(base, AuditHash.rowHashV2(Golden.HASH_B, otherProject, Golden.DIGEST_A), "the project")
        assertNotEquals(base, AuditHash.rowHashV2(Golden.HASH_B, null, Golden.DIGEST_A), "no project is not a project")
        assertNotEquals(base, AuditHash.rowHashV2(Golden.HASH_B, Golden.PROJECT_A, flippedDigest), "the payload digest")
        assertNotEquals(base, AuditHash.rowHashV2(flippedPrev, Golden.PROJECT_A, Golden.DIGEST_A), "the previous hash (the order)")
        assertNotEquals(base, AuditHash.rowHashV2(Golden.DIGEST_A, Golden.PROJECT_A, Golden.HASH_B), "prev_hash and digest are not interchangeable")
    }

    @Test
    fun `every part of a payload changes its digest, one byte is enough`() {
        val base = AuditHash.payloadDigestV2(Golden.SALT_A, Golden.PAYLOAD_A)
        assertNotEquals(base, AuditHash.payloadDigestV2(Golden.SALT_A, Golden.PAYLOAD_A.replace("Betonáž", "Betonaž")), "one letter of the text")
        assertNotEquals(base, AuditHash.payloadDigestV2(Golden.SALT_A, Golden.PAYLOAD_A.replace("ab12", "ab13")), "one digit")
        assertNotEquals(base, AuditHash.payloadDigestV2(Golden.SALT_A, Golden.PAYLOAD_A + " "), "a trailing space")
        assertNotEquals(base, AuditHash.payloadDigestV2(Golden.SALT_A, Golden.PAYLOAD_A.replace("r1", "r2")), "the entity")
        assertNotEquals(base, AuditHash.payloadDigestV2(Golden.SALT_A.replaceRange(63, 64, "e"), Golden.PAYLOAD_A), "one digit of the salt (it ends in f)")
    }

    @Test
    fun `the encoding is unambiguous, moving a byte from one field to the next gives another input`() {
        fun enc(vararg fields: String) = AuditHash.lengthPrefixed(*fields.map { it.toByteArray(Charsets.UTF_8) }.toTypedArray()).toList()
        assertNotEquals(enc("ab", "c"), enc("a", "bc"))
        assertNotEquals(enc("abc", ""), enc("ab", "c"))
        assertNotEquals(enc("", "abc"), enc("abc", ""))
        assertNotEquals(enc("a", "b"), enc("ab"))
        assertNotEquals(enc("a"), enc("a", ""))
        assertEquals(listOf<Byte>(0, 0, 0, 1, 'a'.code.toByte(), 0, 0, 0, 0), enc("a", ""), "4 bytes of length, big-endian, then the bytes")
        // A field longer than 255 bytes: the length is four bytes, not one.
        assertEquals(listOf<Byte>(0, 0, 1, 0), enc("x".repeat(256)).take(4))
    }

    @Test
    fun `values that are not in the exact form are refused, not hashed`() {
        val digest = Golden.DIGEST_A
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(Golden.HASH_A.uppercase(), Golden.PROJECT_A, digest) }
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(Golden.HASH_A.dropLast(1), Golden.PROJECT_A, digest) }
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(Golden.HASH_A + "0", Golden.PROJECT_A, digest) }
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(Golden.HASH_A, Golden.PROJECT_A, digest.uppercase()) }
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(Golden.HASH_A, Golden.PROJECT_A, "x\",\"projectId\":\"") }
        assertThrows<IllegalArgumentException> { AuditHash.payloadDigestV2(Golden.SALT_A.uppercase(), Golden.PAYLOAD_A) }
        assertThrows<IllegalArgumentException> { AuditHash.payloadDigestV2(Golden.SALT_A.dropLast(2), Golden.PAYLOAD_A) }
        assertThrows<IllegalArgumentException> { AuditHash.payloadDigestV2("zz" + Golden.SALT_A.drop(2), Golden.PAYLOAD_A) }
    }
}
