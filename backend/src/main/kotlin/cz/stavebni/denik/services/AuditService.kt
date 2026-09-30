package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.jooq.DSLContext
import org.jooq.JSONB
import org.jooq.kotlin.coroutines.transactionCoroutine
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

@Serializable
data class AuditVerifyResult(
    val ok: Boolean,
    val totalRows: Long,
    /** Id of the first row that broke the chain (null when ok). */
    val brokenAtId: Long? = null,
    val reason: String? = null,
    val checkedAt: String,
)

object AuditService {
    private val json = Json { encodeDefaults = true }

    /**
     * Runs [block] in a transaction that first appends a hash-chained row to
     * `audit_log`. Appends are serialised with a transaction-scoped advisory
     * lock, so the chain stays linear under concurrency; a failing [block]
     * rolls back the audit row together with the business change.
     */
    suspend fun <T> auditedTransaction(
        actor: SessionUser?,
        action: String,
        entityType: String,
        entityId: String,
        before: JsonElement? = null,
        after: JsonElement? = null,
        ip: String? = null,
        userAgent: String? = null,
        block: suspend (DSLContext) -> T
    ): T = withContext(NonCancellable + Dispatchers.IO) {
        DatabaseFactory.dsl.transactionCoroutine { config ->
            val tx = config.dsl()

            // 1. Serialise appenders (same lock key as the original implementation)
            tx.execute("SELECT pg_advisory_xact_lock(42)")

            // 2. Previous hash (genesis for the first row)
            val prevHash = tx.select(AUDIT_LOG.ROW_HASH)
                .from(AUDIT_LOG)
                .orderBy(AUDIT_LOG.ID.desc())
                .limit(1)
                .fetchOne()
                ?.value1()
                ?: AuditHash.GENESIS_HASH

            // 3. Timestamp is part of the hash, so it is stored explicitly
            //    with the same (millisecond) precision that is hashed.
            val ts = OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MILLIS)
            val actorId = actor?.id?.toString()
            val rowHash = AuditHash.rowHash(
                action = action,
                entityType = entityType,
                entityId = entityId,
                actorId = actorId,
                before = before,
                after = after,
                ip = ip,
                userAgent = userAgent,
                prevHash = prevHash,
                ts = ts,
            )

            tx.insertInto(AUDIT_LOG)
                .set(AUDIT_LOG.TS, ts)
                .set(AUDIT_LOG.ACTOR_ID, actorId)
                .set(AUDIT_LOG.ACTION, action)
                .set(AUDIT_LOG.ENTITY_TYPE, entityType)
                .set(AUDIT_LOG.ENTITY_ID, entityId)
                .set(AUDIT_LOG.BEFORE, before?.let { JSONB.jsonb(json.encodeToString(JsonElement.serializer(), it)) })
                .set(AUDIT_LOG.AFTER, after?.let { JSONB.jsonb(json.encodeToString(JsonElement.serializer(), it)) })
                .set(AUDIT_LOG.IP, ip)
                .set(AUDIT_LOG.USER_AGENT, userAgent)
                .set(AUDIT_LOG.PREV_HASH, prevHash)
                .set(AUDIT_LOG.ROW_HASH, rowHash)
                .execute()

            // 4. Business logic in the same transaction
            block(tx)
        }
    }

    /**
     * Walks the whole chain in id order and recomputes every row hash.
     * Returns the first broken row, if any.
     */
    fun verifyChain(tx: DSLContext, batchSize: Int = 1000): AuditVerifyResult {
        var expectedPrev = AuditHash.GENESIS_HASH
        var lastId = 0L
        var total = 0L
        val checkedAt = OffsetDateTime.now(ZoneOffset.UTC).toString()

        while (true) {
            val rows = tx.selectFrom(AUDIT_LOG)
                .where(AUDIT_LOG.ID.gt(lastId))
                .orderBy(AUDIT_LOG.ID.asc())
                .limit(batchSize)
                .fetch()
            if (rows.isEmpty()) break

            for (r in rows) {
                total++
                val id = r.get(AUDIT_LOG.ID)!!
                val prevHash = r.get(AUDIT_LOG.PREV_HASH)!!
                val storedHash = r.get(AUDIT_LOG.ROW_HASH)!!
                if (!AuditHash.hashesEqual(prevHash, expectedPrev)) {
                    return AuditVerifyResult(false, total, id, "prev_hash mismatch on id=$id", checkedAt)
                }
                val recomputed = AuditHash.rowHash(
                    action = r.get(AUDIT_LOG.ACTION)!!,
                    entityType = r.get(AUDIT_LOG.ENTITY_TYPE)!!,
                    entityId = r.get(AUDIT_LOG.ENTITY_ID)!!,
                    actorId = r.get(AUDIT_LOG.ACTOR_ID),
                    before = r.get(AUDIT_LOG.BEFORE)?.data()?.let { Json.parseToJsonElement(it) },
                    after = r.get(AUDIT_LOG.AFTER)?.data()?.let { Json.parseToJsonElement(it) },
                    ip = r.get(AUDIT_LOG.IP),
                    userAgent = r.get(AUDIT_LOG.USER_AGENT),
                    prevHash = prevHash,
                    ts = r.get(AUDIT_LOG.TS)!!,
                )
                if (!AuditHash.hashesEqual(recomputed, storedHash)) {
                    return AuditVerifyResult(false, total, id, "row_hash mismatch on id=$id", checkedAt)
                }
                expectedPrev = storedHash
                lastId = id
            }
        }
        return AuditVerifyResult(true, total, null, null, checkedAt)
    }
}
