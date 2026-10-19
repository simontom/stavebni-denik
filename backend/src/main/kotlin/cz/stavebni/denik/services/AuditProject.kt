package cz.stavebni.denik.services

import cz.stavebni.denik.domain.AuditWriteException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

/**
 * Which project an audit row belongs to. The answer is written to `audit_log.project_id` and is part of the row hash, so that a
 * project's rows can be handed over in full and everybody else's as stubs that still prove their place in the chain.
 *
 * It is worked out **where the row is written** ([AuditService.auditedWrite]), from what the change already says, so that no
 * caller can forget it or get it wrong, and it is worked out **again from the stored payload by the very same rule** when the
 * chain is verified ([ofPayload]): a row that names another project than its payload says (a stolen application password, or a
 * bug, that labelled a row of A as a row of B or of nobody) is found. There is one rule, in one function ([of]), for both.
 *
 * | entity type                                           | the project is                                                      |
 * |-------------------------------------------------------|---------------------------------------------------------------------|
 * | `user`                                                | none: users are global (`user.*` rows, also the operator commands)  |
 * | `project`                                             | the entity itself: creation, identification, site manager, members  |
 * | `report`, `photo`, `siteHandover`, `authorizedPerson` | the `projectId` of the snapshot (`before` and `after` must agree)   |
 *
 * `report` covers the entry and everything attached to it: signature, acknowledgements, addenda and the entries of other
 * parties. Any other entity type is refused: a new kind of row has to be given a rule here, in the same change that adds it,
 * or it would silently belong to no project and always be handed over as a stub (`AuditProjectRowsTest` runs every change of
 * the application and fails on a row without its project).
 *
 * **The rule is part of the format of the hash.** Rows that exist are verified by it, so it may only grow (a new entity type);
 * a change of what an existing type means needs a new hash version.
 *
 * A refusal is an [AuditWriteException]: the message says what is wrong and **nothing of the row**, because it goes to the log.
 */
internal object AuditProject {
    private val BY_SNAPSHOT = setOf("report", "photo", "siteHandover", "authorizedPerson")
    private val UUID_TEXT = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    private val PAYLOAD_PARTS = setOf("entityType", "entityId", "before", "after")

    /** The project of the row, or null for a row that belongs to none. Throws [AuditWriteException] when a row of a project does not name one. */
    fun of(entityType: String, entityId: String, before: JsonElement?, after: JsonElement?): UUID? = when (entityType) {
        "user" -> null
        "project" -> uuid(entityId) ?: throw AuditWriteException("An audit row of a project names the project as its entity, but the entity is not a project id")
        in BY_SNAPSHOT -> fromSnapshots(entityType, before, after)
        else -> throw AuditWriteException(
            "The audit entity type '$entityType' has no rule for the project its rows belong to (AuditProject): add one, " +
                "otherwise its rows would silently belong to no project",
        )
    }

    /** The same, from the payload text of a stored row (the way [AuditHash.payloadV2] wrote it). */
    fun ofPayload(payloadText: String): UUID? {
        val payload = try {
            Json.parseToJsonElement(payloadText) as? JsonObject
        } catch (e: SerializationException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        } ?: throw AuditWriteException("An audit payload is not a JSON object")
        return ofPayload(payload)
    }

    /** The same, from a payload that was parsed already. */
    fun ofPayload(payload: JsonObject): UUID? {
        if (!payload.keys.containsAll(PAYLOAD_PARTS)) throw AuditWriteException("An audit payload lacks a part that the project is worked out from")
        fun text(key: String) = (payload.getValue(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw AuditWriteException("An audit payload has a part of the wrong kind")
        fun snapshot(key: String): JsonElement? = payload.getValue(key).takeUnless { it is JsonNull }
        return of(text("entityType"), text("entityId"), snapshot("before"), snapshot("after"))
    }

    private fun fromSnapshots(entityType: String, before: JsonElement?, after: JsonElement?): UUID {
        val named = listOfNotNull(before, after).map { snapshot ->
            val text = ((snapshot as? JsonObject)?.get("projectId") as? JsonPrimitive)?.takeIf { it.isString }?.content
            text?.let { uuid(it) } ?: throw AuditWriteException("An audit row of type '$entityType' has to say which project it belongs to, but its snapshot has no valid projectId")
        }
        if (named.isEmpty()) throw AuditWriteException("An audit row of type '$entityType' has to say which project it belongs to, but it has no snapshot")
        if (named.toSet().size != 1) throw AuditWriteException("An audit row of type '$entityType' names two different projects (before and after)")
        return named.first()
    }

    private fun uuid(text: String): UUID? = if (UUID_TEXT.matches(text)) UUID.fromString(text) else null
}
