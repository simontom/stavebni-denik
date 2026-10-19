package cz.stavebni.denik.services

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.HexFormat
import java.util.UUID

/**
 * Tamper-evident hash chain of `audit_log`: the bytes that are hashed. The specification, with an example and a reference
 * verifier in Python, is in `PROJECT.md`, "Audit log"; the golden vectors are in `audit-hash-v2-vectors.json`.
 *
 *   payload_digest = sha256_hex( lp("stavebni-denik/audit-payload") || lp(salt, the 32 decoded bytes) || lp(payload_text, UTF-8) )
 *   row_hash       = sha256_hex( lp("stavebni-denik/audit-row") || lp("2") || lp(prev_hash) || lp(project_id, or nothing: 00 00 00 00) || lp(payload_digest) )
 *
 * where `lp(x)` is the 4-byte big-endian length of `x` followed by `x`, `prev_hash` and `payload_digest` are 64 lower-case hex
 * characters, `project_id` is a lower-case UUID, and `payload_text` is the exact text stored in `audit_log.payload_text`: a
 * compact JSON object with the keys action, actorId, after, before, entityId, entityType and ts. Hashing the stored text, not a
 * re-encoding of it, is what keeps verification independent of any JSON library or of jsonb. `row_hash` needs nothing but
 * `prev_hash`, `project_id` and `payload_digest`, so a row can be handed over as a stub that proves its place in the chain and
 * reveals nothing else.
 *
 * There is one format. The "2" in the hash and `audit_log.hash_version` are there so that a later one can be told apart; a row
 * that was written is never hashed again.
 */
object AuditHash {
    const val GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000"

    /** The format of the hash of every row. */
    const val VERSION_2 = 2

    private val json = Json { encodeDefaults = true }
    private val TS_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")

    fun formatTs(ts: OffsetDateTime): String = ts.withOffsetSameInstant(ZoneOffset.UTC).format(TS_FORMAT)

    // Used by the signature formats of an entry (ReportSignature), whose hashes are pinned by golden vectors: do not change.
    fun canonicalize(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> JsonObject(element.keys.sorted().associateWith { canonicalize(element.getValue(it)) })
        is JsonArray -> JsonArray(element.map { canonicalize(it) })
        else -> element
    }

    fun canonicalJson(element: JsonElement): String =
        json.encodeToString(JsonElement.serializer(), canonicalize(element))

    const val SALT_BYTES = 32

    private const val PAYLOAD_TAG = "stavebni-denik/audit-payload"
    private const val ROW_TAG = "stavebni-denik/audit-row"
    private val HEX_64 = Regex("[0-9a-f]{64}")
    private val HEX = HexFormat.of()
    private val random = SecureRandom()

    /** A new salt for one row: 32 bytes from a cryptographically strong generator, as 64 lower-case hex characters. */
    fun newSalt(): String = HEX.formatHex(ByteArray(SALT_BYTES).also { random.nextBytes(it) })

    /**
     * The payload of a version 2 row: everything the row says, as the text that is hashed, stored in `audit_log.payload_text`
     * and never composed again (a verifier hashes the stored text, it does not rebuild it). A compact JSON object with the
     * keys action, actorId, after, before, entityId, entityType and ts, sorted at every level. Numbers are written as the
     * snapshot had them (`12.0` stays `12.0`, `1e-7` stays `1e-7`, a number too big for a double stays exact): `kotlinx`'s own
     * encoder would turn them into doubles, and this record is evidence.
     *
     * The text is passed through UTF-8 once, here: a character that has no UTF-8 form (a lone surrogate) becomes `?` now,
     * so that the bytes that are hashed and the text that is stored are the same whatever a database driver would do with it.
     */
    fun payloadV2(
        action: String,
        actorId: String?,
        entityType: String,
        entityId: String,
        before: JsonElement?,
        after: JsonElement?,
        ts: OffsetDateTime,
    ): String {
        val payload = buildJsonObject {
            put("action", action)
            put("actorId", actorId)
            put("after", after ?: JsonNull)
            put("before", before ?: JsonNull)
            put("entityId", entityId)
            put("entityType", entityType)
            put("ts", formatTs(ts))
        }
        return String(StringBuilder().also { appendCompact(it, payload) }.toString().utf8(), Charsets.UTF_8)
    }

    private val JSON_NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")

    /** Compact JSON, object keys sorted, strings quoted and escaped as `kotlinx` does, numbers and literals exactly as they are. */
    private fun appendCompact(out: StringBuilder, element: JsonElement) {
        when (element) {
            is JsonNull -> out.append("null")
            is JsonPrimitive -> {
                if (element.isString) {
                    out.append(element.toString())
                } else {
                    // A literal that is neither a number nor a boolean would not be JSON: refuse it instead of writing it. The
                    // message is for the log and says nothing of the literal.
                    require(element.content == "true" || element.content == "false" || JSON_NUMBER.matches(element.content)) {
                        "a snapshot holds a literal that is not a JSON number or boolean"
                    }
                    out.append(element.content)
                }
            }
            is JsonArray -> {
                out.append('[')
                element.forEachIndexed { i, item -> if (i > 0) out.append(','); appendCompact(out, item) }
                out.append(']')
            }
            is JsonObject -> {
                out.append('{')
                element.keys.sorted().forEachIndexed { i, key ->
                    if (i > 0) out.append(',')
                    out.append(JsonPrimitive(key).toString()).append(':')
                    appendCompact(out, element.getValue(key))
                }
                out.append('}')
            }
        }
    }

    /**
     * The salted digest of a payload: `sha256_hex( lp(tag) || lp(salt) || lp(payload UTF-8) )`. The salt (32 random bytes, new
     * for every row, never part of a stub) is what stops anybody who holds a stub from confirming a guess about the payload.
     */
    fun payloadDigestV2(saltHex: String, payloadText: String): String {
        require(HEX_64.matches(saltHex)) { "the salt is not 32 bytes as 64 lower-case hex characters" }
        return sha256Hex(lengthPrefixed(PAYLOAD_TAG.utf8(), HEX.parseHex(saltHex), payloadText.utf8()))
    }

    /**
     * The hash of a version 2 row: `sha256_hex( lp(tag) || lp("2") || lp(prev_hash) || lp(project_id or "") || lp(payload_digest) )`.
     * These are all a stub carries. The project is a lower-case UUID, or empty for a row that belongs to no project (a UUID
     * is never empty, so "no project" cannot be mistaken for one).
     */
    fun rowHashV2(prevHash: String, projectId: UUID?, payloadDigest: String): String {
        require(HEX_64.matches(prevHash)) { "prev_hash is not 64 lower-case hex characters" }
        require(HEX_64.matches(payloadDigest)) { "the payload digest is not 64 lower-case hex characters" }
        return sha256Hex(
            lengthPrefixed(ROW_TAG.utf8(), VERSION_2.toString().utf8(), prevHash.utf8(), (projectId?.toString() ?: "").utf8(), payloadDigest.utf8()),
        )
    }

    /** `lp(f1) || lp(f2) || ...`, where `lp(x)` is the length of `x` as 4 bytes, big-endian, followed by `x`: no two lists of fields give the same bytes. */
    internal fun lengthPrefixed(vararg fields: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        for (field in fields) {
            out.write(ByteBuffer.allocate(4).putInt(field.size).array())
            out.write(field)
        }
        return out.toByteArray()
    }

    private fun String.utf8(): ByteArray = toByteArray(Charsets.UTF_8)

    private fun sha256Hex(bytes: ByteArray): String = HEX.formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun sha256Hex(input: String): String = sha256Hex(input.utf8())

    /** Constant-time comparison of two hex digests. */
    fun hashesEqual(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.US_ASCII), b.toByteArray(Charsets.US_ASCII))
}
