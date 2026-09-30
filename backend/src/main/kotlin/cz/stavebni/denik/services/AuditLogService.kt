package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import java.util.UUID

@Serializable
data class AuditEntryDto(
    val id: Long,
    val ts: String,
    val actorId: String? = null,
    val actorNickname: String? = null,
    val action: String,
    val entityType: String,
    val entityId: String,
    val rowHash: String,
)

/** Read side of the append-only audit log (admins only). */
object AuditLogService {

    fun verify(tx: DSLContext, actor: SessionUser): AuditVerifyResult {
        assertCan(actor, Action.AuditVerify)
        return AuditService.verifyChain(tx)
    }

    fun list(tx: DSLContext, actor: SessionUser, limit: Int = 200): List<AuditEntryDto> {
        assertCan(actor, Action.AuditRead)
        val rows = tx.selectFrom(AUDIT_LOG)
            .orderBy(AUDIT_LOG.ID.desc())
            .limit(limit.coerceIn(1, 1000))
            .fetch()

        val actorIds = rows.mapNotNull { r ->
            r.get(AUDIT_LOG.ACTOR_ID)?.let { runCatching { UUID.fromString(it) }.getOrNull() }
        }.toSet()
        val nicknames: Map<String, String> = if (actorIds.isEmpty()) emptyMap() else
            tx.select(USERS.ID, USERS.NICKNAME)
                .from(USERS)
                .where(USERS.ID.`in`(actorIds))
                .fetch()
                .associate { it.get(USERS.ID).toString() to it.get(USERS.NICKNAME)!! }

        return rows.map { r ->
            val actorId = r.get(AUDIT_LOG.ACTOR_ID)
            AuditEntryDto(
                id = r.get(AUDIT_LOG.ID)!!,
                ts = r.get(AUDIT_LOG.TS).toString(),
                actorId = actorId,
                actorNickname = actorId?.let { nicknames[it] },
                action = r.get(AUDIT_LOG.ACTION)!!,
                entityType = r.get(AUDIT_LOG.ENTITY_TYPE)!!,
                entityId = r.get(AUDIT_LOG.ENTITY_ID)!!,
                rowHash = r.get(AUDIT_LOG.ROW_HASH)!!,
            )
        }
    }
}
