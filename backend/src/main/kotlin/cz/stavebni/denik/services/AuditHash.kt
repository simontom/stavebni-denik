package cz.stavebni.denik.services

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Tamper-evident hash chain of `audit_log`.
 *
 * Byte-compatible with the canonical scheme of the original implementation
 * (`src/server/audit-hash.ts`, used by the nightly `scripts/verify-audit.ts`):
 *
 *   row_hash = sha256_hex( canonicalJSON({ action, actorId, after, before,
 *                                          entityId, entityType, ip, prevHash,
 *                                          ts, userAgent }) )
 *
 * where canonicalJSON sorts object keys at every level, keeps array order,
 * maps missing values to `null`, and `ts` is the row timestamp as
 * `YYYY-MM-DDTHH:mm:ss.SSSZ` (UTC, millisecond precision - exactly what is
 * stored in the `ts` column).
 */
object AuditHash {
    const val GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000"

    private val json = Json { encodeDefaults = true }
    private val TS_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")

    fun formatTs(ts: OffsetDateTime): String = ts.withOffsetSameInstant(ZoneOffset.UTC).format(TS_FORMAT)

    fun canonicalize(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> JsonObject(element.keys.sorted().associateWith { canonicalize(element.getValue(it)) })
        is JsonArray -> JsonArray(element.map { canonicalize(it) })
        else -> element
    }

    fun canonicalJson(element: JsonElement): String =
        json.encodeToString(JsonElement.serializer(), canonicalize(element))

    fun rowHash(
        action: String,
        entityType: String,
        entityId: String,
        actorId: String?,
        before: JsonElement?,
        after: JsonElement?,
        ip: String?,
        userAgent: String?,
        prevHash: String,
        ts: OffsetDateTime,
    ): String {
        val payload = buildJsonObject {
            put("action", action)
            put("actorId", actorId)
            put("after", after ?: JsonNull)
            put("before", before ?: JsonNull)
            put("entityId", entityId)
            put("entityType", entityType)
            put("ip", ip)
            put("prevHash", prevHash)
            put("ts", formatTs(ts))
            put("userAgent", userAgent)
        }
        return sha256Hex(canonicalJson(payload))
    }

    fun sha256Hex(input: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    /** Constant-time comparison of two hex digests. */
    fun hashesEqual(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.US_ASCII), b.toByteArray(Charsets.US_ASCII))
}
