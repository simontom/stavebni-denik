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
            tx.execute(AUDIT_LOCK_SQL)

            // 2. The audit row is written before the business logic, so the caller has to
            //    know the entity id (and any snapshots) up front.
            appendRow(tx, actor, action, entityType, entityId, before, after, ip, userAgent)

            // 3. Business logic in the same transaction
            block(tx)
        }
    }

    /**
     * Outcome of a [auditedWrite] block: the value to return plus what the audit row
     * should record. Everything here is only known once the change has been made
     * (the id of a row that was just created, its state after the change).
     */
    class Audited<T>(
        val result: T,
        val action: String,
        val entityId: String,
        val before: JsonElement? = null,
        val after: JsonElement? = null,
    )

    /**
     * The write path for changes that must be authorized, applied and audited as one unit.
     *
     * Takes the audit lock first, so concurrent writers are strictly serialised: [block]
     * can read the current state (lock flags, membership) and act on it without a
     * check-then-act race. It runs in the transaction and appends the audit row
     * *afterwards*, with the real entity id and the before/after snapshots it returns.
     * An exception thrown by [block] rolls the whole transaction back, so there is no
     * audit row for a change that did not happen.
     *
     * [block] is deliberately not `suspend`: nothing slow (HTTP calls, image or PDF work)
     * may run while the lock is held, and a nested audited write would deadlock on it.
     */
    suspend fun <T> auditedWrite(
        actor: SessionUser?,
        entityType: String,
        block: (DSLContext) -> Audited<T>,
    ): T = withContext(NonCancellable + Dispatchers.IO) {
        DatabaseFactory.dsl.transactionCoroutine { config ->
            val tx = config.dsl()
            tx.execute(AUDIT_LOCK_SQL)
            val outcome = block(tx)
            appendRow(tx, actor, outcome.action, entityType, outcome.entityId, outcome.before, outcome.after, null, null)
            outcome.result
        }
    }

    /** Same lock key as the original implementation. */
    private const val AUDIT_LOCK_SQL = "SELECT pg_advisory_xact_lock(42)"

    /** Appends one hash-chained row. Must run under [AUDIT_LOCK_SQL] in the caller's transaction. */
    private fun appendRow(
        tx: DSLContext,
        actor: SessionUser?,
        action: String,
        entityType: String,
        entityId: String,
        before: JsonElement?,
        after: JsonElement?,
        ip: String?,
        userAgent: String?,
    ) {
        // Previous hash (genesis for the first row)
        val prevHash = tx.select(AUDIT_LOG.ROW_HASH)
            .from(AUDIT_LOG)
            .orderBy(AUDIT_LOG.ID.desc())
            .limit(1)
            .fetchOne()
            ?.value1()
            ?: AuditHash.GENESIS_HASH

        // The timestamp is part of the hash, so it is stored explicitly
        // with the same (millisecond) precision that is hashed.
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
