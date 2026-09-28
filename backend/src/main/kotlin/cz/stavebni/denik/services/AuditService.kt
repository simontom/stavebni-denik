package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.jooq.DSLContext
import org.jooq.JSONB
import org.jooq.kotlin.coroutines.transactionCoroutine
import java.security.MessageDigest

object AuditService {
    private val json = Json { encodeDefaults = true }

    suspend fun <T> auditedTransaction(
        actor: SessionUser?,
        action: String,
        entityType: String,
        entityId: String,
        before: Any? = null,
        after: Any? = null,
        ip: String? = null,
        userAgent: String? = null,
        block: suspend (DSLContext) -> T
    ): T = withContext(NonCancellable + Dispatchers.IO) {
        DatabaseFactory.dsl.transactionCoroutine { config ->
            val tx = config.dsl()
            
            // 1. Acquire advisory lock
            tx.execute("SELECT pg_advisory_xact_lock(42)")

            // 2. Get previous hash
            val prevHashRecord = tx.select(AUDIT_LOG.ROW_HASH)
                .from(AUDIT_LOG)
                .orderBy(AUDIT_LOG.ID.desc())
                .limit(1)
                .fetchOne()
            
            val prevHash = prevHashRecord?.value1() ?: "0000000000000000000000000000000000000000000000000000000000000000"

            // 3. Convert before/after
            val beforeJson = before?.let { JSONB.jsonb(json.encodeToString(it)) }
            val afterJson = after?.let { JSONB.jsonb(json.encodeToString(it)) }

            // 4. Calculate new hash
            // Format: prev_hash + action + entity_type + entity_id + before + after
            val payload = buildString {
                append(prevHash)
                append(action)
                append(entityType)
                append(entityId)
                append(beforeJson?.data() ?: "")
                append(afterJson?.data() ?: "")
            }
            val newHash = hashPayload(payload)

            // 5. Insert audit log
            tx.insertInto(AUDIT_LOG)
                .set(AUDIT_LOG.ACTOR_ID, actor?.id?.toString())
                .set(AUDIT_LOG.ACTION, action)
                .set(AUDIT_LOG.ENTITY_TYPE, entityType)
                .set(AUDIT_LOG.ENTITY_ID, entityId)
                .set(AUDIT_LOG.BEFORE, beforeJson)
                .set(AUDIT_LOG.AFTER, afterJson)
                .set(AUDIT_LOG.IP, ip)
                .set(AUDIT_LOG.USER_AGENT, userAgent)
                .set(AUDIT_LOG.PREV_HASH, prevHash)
                .set(AUDIT_LOG.ROW_HASH, newHash)
                .execute()

            // 6. Execute business logic
            block(tx)
        }
    }

    private fun hashPayload(payload: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(payload.toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }
}

