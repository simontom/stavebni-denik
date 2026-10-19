package cz.stavebni.denik.services

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

/**
 * Which project an audit row belongs to. The answer is written to `audit_log.project_id` and is part of the row hash (hash
 * version 2), so that a project's rows can be handed over in full and everybody else's as stubs that still prove their place
 * in the chain.
 *
 * It is worked out **where the row is written** ([AuditService.auditedWrite]), from what the change already says, so that no
 * caller can forget it or get it wrong:
 *
 * | entity type                                      | the project is                                                           |
 * |--------------------------------------------------|--------------------------------------------------------------------------|
 * | `user`                                           | none: users are global (`user.*` rows, also the operator commands)       |
 * | `project`                                        | the entity itself: creation, identification, site manager, members       |
 * | `report`, `photo`, `siteHandover`, `authorizedPerson` | the `projectId` of the snapshot (`before` and `after` must agree)   |
 *
 * `report` covers the entry and everything attached to it: signature, acknowledgements, addenda and the entries of other
 * parties. Any other entity type is refused: a new kind of row has to be given a rule here, in the same change that adds it,
 * or it would silently belong to no project and always be handed over as a stub.
 *
 * Verification does **not** apply this rule again: what is in `project_id` is what was hashed, and the rule may grow.
 */
internal object AuditProject {
    private val BY_SNAPSHOT = setOf("report", "photo", "siteHandover", "authorizedPerson")
    private val UUID_TEXT = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

    /** The project of the row, or null for a row that belongs to none. Throws [IllegalStateException] when a row of a project does not name one. */
    fun of(entityType: String, entityId: String, before: JsonElement?, after: JsonElement?): UUID? = when (entityType) {
        "user" -> null
        "project" -> uuid(entityId) ?: throw IllegalStateException("An audit row of a project names the project as its entity, but '$entityId' is not a project id")
        in BY_SNAPSHOT -> fromSnapshots(entityType, before, after)
        else -> throw IllegalStateException(
            "The audit entity type '$entityType' has no rule for the project its rows belong to (AuditProject): add one, " +
                "otherwise its rows would silently belong to no project",
        )
    }

    private fun fromSnapshots(entityType: String, before: JsonElement?, after: JsonElement?): UUID {
        val named = listOfNotNull(before, after).map { snapshot ->
            val text = ((snapshot as? JsonObject)?.get("projectId") as? JsonPrimitive)?.takeIf { it.isString }?.content
            text?.let { uuid(it) } ?: throw IllegalStateException("An audit row of type '$entityType' has to say which project it belongs to, but its snapshot has no valid projectId")
        }
        check(named.isNotEmpty()) { "An audit row of type '$entityType' has to say which project it belongs to, but it has no snapshot" }
        check(named.toSet().size == 1) { "An audit row of type '$entityType' names two different projects (before and after): $named" }
        return named.first()
    }

    private fun uuid(text: String): UUID? = if (UUID_TEXT.matches(text)) UUID.fromString(text) else null
}
