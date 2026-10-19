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
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.UUID

class AuditHashTest {

    @Test
    fun `timestamps are hashed in UTC with millisecond precision`() {
        assertEquals("2026-09-30T10:34:56.789Z", AuditHash.formatTs(OffsetDateTime.parse("2026-09-30T12:34:56.789+02:00")))
        assertEquals("2026-09-30T12:34:56.000Z", AuditHash.formatTs(OffsetDateTime.parse("2026-09-30T12:34:56Z")))
    }

    // --- golden vectors ---------------------------------------------------------------------------------------------------

    /**
     * Pinned inputs and outputs, in `audit-hash-v2-vectors.json`. They were computed by an independent implementation (a few
     * lines of node's `crypto`, written from the specification in `PROJECT.md`, not from this code), and the same file is read by
     * the Python reference verifier (`scripts/audit/verify-audit-hash.py`, run by [AuditSpecificationTest]), so a verifier in
     * another language written from that specification must produce exactly these values. A change here is a change of the
     * format: it breaks every row already written, and every stub already handed over.
     */
    private class Vector(val salt: String, val projectId: UUID?, val payloadText: String, val prevHash: String, val digest: String, val rowHash: String)

    private fun vector(name: String): Vector {
        val file = javaClass.getResourceAsStream("/audit-hash-v2-vectors.json")!!.use { Json.parseToJsonElement(it.readBytes().toString(Charsets.UTF_8)).jsonObject }
        val v = file.getValue(name).jsonObject
        fun text(key: String) = v.getValue(key).jsonPrimitive.content
        return Vector(
            text("salt"), v.getValue("projectId").takeUnless { it is JsonNull }?.jsonPrimitive?.content?.let { UUID.fromString(it) },
            text("payloadText"), text("prevHash"), text("payloadDigest"), text("rowHash"),
        )
    }

    private val a get() = vector("rowOfAProject")
    private val b get() = vector("rowOfNoProject")

    @Test
    fun `golden vector of a row of a project`() {
        assertEquals(AuditHash.GENESIS_HASH, a.prevHash)
        assertEquals(a.digest, AuditHash.payloadDigestV2(a.salt, a.payloadText))
        assertEquals(a.rowHash, AuditHash.rowHashV2(a.prevHash, a.projectId, a.digest))
    }

    @Test
    fun `golden vector of a row that belongs to no project, chained after the first`() {
        assertEquals(a.rowHash, b.prevHash)
        assertEquals(b.digest, AuditHash.payloadDigestV2(b.salt, b.payloadText))
        assertEquals(b.rowHash, AuditHash.rowHashV2(b.prevHash, null, b.digest))
    }

    // --- the byte layout, written out ---------------------------------------------------------------------------------------

    private fun lp(bytes: ByteArray): ByteArray {
        val length = bytes.size
        return byteArrayOf((length ushr 24).toByte(), (length ushr 16).toByte(), (length ushr 8).toByte(), length.toByte()) + bytes
    }

    private fun lp(text: String) = lp(text.toByteArray(Charsets.UTF_8))

    private fun sha256(vararg parts: ByteArray): String {
        val all = ByteArrayOutputStream().also { out -> parts.forEach { out.write(it) } }.toByteArray()
        return MessageDigest.getInstance("SHA-256").digest(all).joinToString("") { "%02x".format(it) }
    }

    private fun hexBytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun `the digest is hashed over the tag, the DECODED 32 bytes of the salt, and the payload, each with its length in front`() {
        val expected = sha256(lp("stavebni-denik/audit-payload"), lp(hexBytes(a.salt)), lp(a.payloadText))
        assertEquals(expected, AuditHash.payloadDigestV2(a.salt, a.payloadText))
        // The salt as hex text (64 characters) is a different input and gives a different digest: a verifier must decode it.
        assertNotEquals(expected, sha256(lp("stavebni-denik/audit-payload"), lp(a.salt), lp(a.payloadText)))
        assertEquals(32, hexBytes(a.salt).size)
    }

    @Test
    fun `the row hash is hashed over the tag, the version, the previous hash, the project and the digest, each with its length in front`() {
        val withProject = sha256(lp("stavebni-denik/audit-row"), lp("2"), lp(a.prevHash), lp(a.projectId.toString()), lp(a.digest))
        assertEquals(withProject, AuditHash.rowHashV2(a.prevHash, a.projectId, a.digest))
        // No project is a field of length zero (00 00 00 00), not a missing field.
        val noProject = sha256(lp("stavebni-denik/audit-row"), lp("2"), lp(b.prevHash), byteArrayOf(0, 0, 0, 0), lp(b.digest))
        assertEquals(noProject, AuditHash.rowHashV2(b.prevHash, null, b.digest))
        val omitted = sha256(lp("stavebni-denik/audit-row"), lp("2"), lp(b.prevHash), lp(b.digest))
        assertNotEquals(omitted, AuditHash.rowHashV2(b.prevHash, null, b.digest), "an omitted field is another input")
        // The lengths of the fixed fields, as the specification gives them.
        assertEquals(28, "stavebni-denik/audit-payload".length)
        assertEquals(24, "stavebni-denik/audit-row".length)
    }

    // --- the payload --------------------------------------------------------------------------------------------------------

    @Test
    fun `the payload is the canonical text that the golden vector hashes, numbers and letters exactly as written`() {
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
        assertEquals(a.payloadText, text)

        val user = AuditHash.payloadV2(
            action = "user.update", actorId = null, entityType = "user", entityId = "22222222-2222-2222-2222-222222222222",
            before = Json.parseToJsonElement("""{"role":"WORKER"}"""), after = Json.parseToJsonElement("""{"role":"BOSS"}"""),
            ts = OffsetDateTime.parse("2026-10-18T09:31:00Z"),
        )
        assertEquals(b.payloadText, user)
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
    fun `a literal that is not JSON is refused instead of written into the payload, and the refusal does not echo it`() {
        val injected = buildJsonObject { put("n", JsonUnquotedLiteral("""1,"action":"secret-value"""")) }
        val error = assertThrows<IllegalArgumentException> {
            AuditHash.payloadV2("a", null, "user", "1", null, injected, OffsetDateTime.parse("2026-10-18T09:31:00Z"))
        }
        assertFalse(error.message!!.contains("secret-value"), "the message is for the log and holds no content of the row: ${error.message}")
    }

    private fun nested(containers: Int): kotlinx.serialization.json.JsonElement {
        var element: kotlinx.serialization.json.JsonElement = kotlinx.serialization.json.JsonArray(emptyList())
        repeat(containers - 1) { element = kotlinx.serialization.json.JsonArray(listOf(element)) }
        return element
    }

    @Test
    fun `a snapshot nested deeper than the limit is refused, and the refusal says nothing of it`() {
        val ts = OffsetDateTime.parse("2026-10-18T09:31:00Z")
        // The object of the payload is the first level, so a snapshot of MAX - 1 containers makes the deepest payload allowed.
        val written = AuditHash.payloadV2("a.b", null, "user", "1", null, nested(AuditHash.MAX_JSON_DEPTH - 1), ts)
        assertFalse(AuditHash.isNestedDeeperThan(written, AuditHash.MAX_JSON_DEPTH), "what the writer writes, the verifier accepts")
        assertTrue(AuditHash.isNestedDeeperThan(written, AuditHash.MAX_JSON_DEPTH - 1))

        val error = assertThrows<IllegalArgumentException> {
            AuditHash.payloadV2("a.b", null, "user", "1", nested(AuditHash.MAX_JSON_DEPTH), null, ts)
        }
        assertTrue(error.message!!.contains("nested"), error.message)
        // And a snapshot that would take the writer's own recursion down is refused after a few levels, not after all of them.
        assertThrows<IllegalArgumentException> { AuditHash.payloadV2("a.b", null, "user", "1", nested(5_000), null, ts) }
    }

    @Test
    fun `the depth of a text is counted without parsing it, and brackets inside strings do not count`() {
        assertFalse(AuditHash.isNestedDeeperThan("[[[]]]", 3))
        assertTrue(AuditHash.isNestedDeeperThan("[[[[]]]]", 3))
        assertFalse(AuditHash.isNestedDeeperThan("""{"a":[1,2,{"b":null}]}""", 3))
        assertTrue(AuditHash.isNestedDeeperThan("""{"a":[1,2,{"b":null}]}""", 2))
        // Brackets and braces in strings, escaped quotes and escaped backslashes.
        assertFalse(AuditHash.isNestedDeeperThan("""{"a":"[[[[[[[[","b":"\"[[[[[","c":"\\"}""", 1))
        assertFalse(AuditHash.isNestedDeeperThan("""["\\", "[[[["]""", 1))
        assertFalse(AuditHash.isNestedDeeperThan("", 1))
        // Hundreds of thousands of levels: answered, not overflowed.
        assertTrue(AuditHash.isNestedDeeperThan("[".repeat(500_000) + "]".repeat(500_000), AuditHash.MAX_JSON_DEPTH))
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

    // --- what a stub is ---------------------------------------------------------------------------------------------------

    @Test
    fun `a stub carries everything needed to recompute the row hash and nothing of the payload`() {
        // The row hash is a function of three things only: where the row sits in the chain (prev_hash), which project it
        // belongs to, and the digest of what it says. A recipient of a stub has exactly these.
        assertEquals(a.rowHash, AuditHash.rowHashV2(a.prevHash, a.projectId, a.digest))
        assertEquals(b.rowHash, AuditHash.rowHashV2(b.prevHash, b.projectId, b.digest))
    }

    @Test
    fun `without the salt a guess about the payload cannot be confirmed from the digest`() {
        // What a recipient could do with a stub if the digest were not salted: hash a guess and compare.
        assertNotEquals(a.digest, AuditHash.sha256Hex(a.payloadText))
        // And the same text under another salt gives an unrelated digest: the digest of a row says nothing about another row.
        assertNotEquals(a.digest, AuditHash.payloadDigestV2(b.salt, a.payloadText))
    }

    @Test
    fun `a new salt is 32 random bytes as lower-case hex and is never reused`() {
        val salts = (1..50).map { AuditHash.newSalt() }
        assertTrue(salts.all { Regex("[0-9a-f]{64}").matches(it) }, "64 lower-case hex characters")
        assertEquals(50, salts.toSet().size, "every salt is new")
    }

    // --- nothing can be changed without changing the hash -------------------------------------------------------------------

    @Test
    fun `every part of a row changes its hash`() {
        val base = AuditHash.rowHashV2(b.rowHash, a.projectId, a.digest)
        val otherProject = UUID.fromString("01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0f")
        val flippedDigest = a.digest.replaceRange(0, 1, if (a.digest[0] == '0') "1" else "0")
        val flippedPrev = b.rowHash.replaceRange(63, 64, if (b.rowHash[63] == '0') "1" else "0")

        assertNotEquals(base, AuditHash.rowHashV2(b.rowHash, otherProject, a.digest), "the project")
        assertNotEquals(base, AuditHash.rowHashV2(b.rowHash, null, a.digest), "no project is not a project")
        assertNotEquals(base, AuditHash.rowHashV2(b.rowHash, a.projectId, flippedDigest), "the payload digest")
        assertNotEquals(base, AuditHash.rowHashV2(flippedPrev, a.projectId, a.digest), "the previous hash (the order)")
        assertNotEquals(base, AuditHash.rowHashV2(a.digest, a.projectId, b.rowHash), "prev_hash and digest are not interchangeable")
    }

    @Test
    fun `every part of a payload changes its digest, one byte is enough`() {
        val base = AuditHash.payloadDigestV2(a.salt, a.payloadText)
        assertNotEquals(base, AuditHash.payloadDigestV2(a.salt, a.payloadText.replace("Betonáž", "Betonaž")), "one letter of the text")
        assertNotEquals(base, AuditHash.payloadDigestV2(a.salt, a.payloadText.replace("ab12", "ab13")), "one digit")
        assertNotEquals(base, AuditHash.payloadDigestV2(a.salt, a.payloadText + " "), "a trailing space")
        assertNotEquals(base, AuditHash.payloadDigestV2(a.salt, a.payloadText.replace("r1", "r2")), "the entity")
        assertNotEquals(base, AuditHash.payloadDigestV2(a.salt.replaceRange(63, 64, "e"), a.payloadText), "one digit of the salt (it ends in f)")
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
        val digest = a.digest
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(a.rowHash.uppercase(), a.projectId, digest) }
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(a.rowHash.dropLast(1), a.projectId, digest) }
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(a.rowHash + "0", a.projectId, digest) }
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(a.rowHash, a.projectId, digest.uppercase()) }
        assertThrows<IllegalArgumentException> { AuditHash.rowHashV2(a.rowHash, a.projectId, "x\",\"projectId\":\"") }
        assertThrows<IllegalArgumentException> { AuditHash.payloadDigestV2(a.salt.uppercase(), a.payloadText) }
        assertThrows<IllegalArgumentException> { AuditHash.payloadDigestV2(a.salt.dropLast(2), a.payloadText) }
        assertThrows<IllegalArgumentException> { AuditHash.payloadDigestV2("zz" + a.salt.drop(2), a.payloadText) }
    }
}
