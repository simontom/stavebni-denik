package cz.stavebni.denik.services

import cz.stavebni.denik.domain.HandoverSide
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.Role
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.time.OffsetDateTime

/**
 * What a signature of a handover protocol covers (backlog A3), **format 1, frozen**: a signature made today has to verify in ten
 * years, so a field that is added later needs a format 2, and a key is never renamed. `HandoverHashTest` pins the exact text and
 * the hashes, made by a script that shares no code with this.
 *
 * Two hashes, both SHA-256 of the canonical JSON (`AuditHash.canonicalJson`: sorted keys, compact, the writer of the entry's
 * signature) of what is built **from the stored rows only**, never from the request:
 *
 * - the **content hash**: `{format, id, projectId, type, date, participants, meterStates, notes}`: what both parties agree on, so
 *   it is the same for both signatures of a protocol. `date` is `YYYY-MM-DD`, no meters is `[]`, no notes is `null`, and the
 *   meters keep the order they were entered in;
 * - the **signature hash**: `{format, side, contentSha256, signedAt, signedById, signerName, signerRole, signerCkaitNumber}`: it
 *   binds who signed which side, when, and in which role to that content. `signedAt` is UTC with milliseconds (what is stored),
 *   the number is the contractor's and `null` for the client.
 */
internal object HandoverHash {
    const val FORMAT = 1

    /** The content both parties sign. [date] is `YYYY-MM-DD`; a missing list of meters is the empty list. */
    fun content(id: String, projectId: String, type: String, date: String, participants: String, meterStates: List<MeterState>?, notes: String?): JsonObject =
        buildJsonObject {
            put("format", FORMAT)
            put("id", id)
            put("projectId", projectId)
            put("type", type)
            put("date", date)
            put("participants", participants)
            put(
                "meterStates",
                JsonArray(
                    meterStates.orEmpty().map { m ->
                        buildJsonObject {
                            put("medium", m.medium)
                            put("serialNumber", m.serialNumber)
                            put("state", m.state)
                        }
                    },
                ),
            )
            put("notes", notes)
        }

    fun contentHash(content: JsonObject): String = sha256(AuditHash.canonicalJson(content))

    /** What one party signs: the content (by its hash), who, for which side, when, in which role and, for the contractor, with which number. */
    fun signature(
        side: HandoverSide,
        contentHash: String,
        signedAt: OffsetDateTime,
        signedById: String,
        signerName: String,
        signerRole: Role,
        signerCkaitNumber: String?,
    ): JsonObject = buildJsonObject {
        put("format", FORMAT)
        put("side", side.name)
        put("contentSha256", contentHash)
        put("signedAt", AuditHash.formatTs(signedAt))
        put("signedById", signedById)
        put("signerName", signerName)
        put("signerRole", signerRole.name)
        put("signerCkaitNumber", signerCkaitNumber?.let { JsonPrimitive(it) } ?: JsonNull)
    }

    fun signatureHash(signature: JsonObject): String = sha256(AuditHash.canonicalJson(signature))

    private fun sha256(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
