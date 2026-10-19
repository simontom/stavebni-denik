package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.AuditWriteException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.AUDIT_REQUEST_CONTEXT
import cz.stavebni.denik.plugins.RequestContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jooq.DSLContext
import org.jooq.Record
import org.jooq.impl.DSL
import org.jooq.kotlin.coroutines.transactionCoroutine
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

/**
 * The newest row of the chain: id and row hash. Written down somewhere outside the database (a private
 * repository, a timestamping service), it later proves that nothing up to that row was removed or
 * rewritten, which the chain alone cannot: an attacker who deletes the newest rows, or the whole log,
 * leaves a chain that is still internally consistent. Text form: `<id>:<rowHash>`.
 */
@Serializable
data class AuditAnchor(val id: Long, val rowHash: String) {
    override fun toString() = "$id:$rowHash"

    companion object {
        /** Parses `<id>:<rowHash>`; null when the text is not of that form. */
        fun parse(text: String): AuditAnchor? {
            val id = text.substringBefore(':').trim().toLongOrNull() ?: return null
            val hash = text.substringAfter(':', "").trim()
            return if (hash.isNotEmpty() && hash.all { it.isLetterOrDigit() }) AuditAnchor(id, hash) else null
        }
    }
}

@Serializable
data class AuditVerifyResult(
    val ok: Boolean,
    val totalRows: Long,
    /** Id of the first row that broke the chain (null when ok). */
    val brokenAtId: Long? = null,
    val reason: String? = null,
    val checkedAt: String,
    /** The newest row of the chain; record it outside the database and pass it back as the anchor next time. */
    val head: AuditAnchor? = null,
)

object AuditService {

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
        /**
         * Further rows of the same change, appended right after this one in the same transaction, with the same actor, entity
         * type and request: for a change that is several facts, such as a project created together with its first members.
         */
        val alsoRecorded: List<Audited<Unit>> = emptyList(),
    )

    /**
     * The write path for changes that must be authorized, applied and audited as one unit. **Every change to a record of
     * the diary and to a user goes through it**; it is the only way an audit row is written.
     *
     * Takes the audit lock first, so concurrent writers are strictly serialised: [block]
     * can read the current state (lock flags, membership) and act on it without a
     * check-then-act race. It runs in the transaction and appends the audit row
     * *afterwards*, with the real entity id and the before/after snapshots it returns.
     * An exception thrown by [block] rolls the whole transaction back, so there is no
     * audit row for a change that did not happen. The project the row belongs to is worked
     * out from what [block] returns ([AuditProject]); a row that cannot be given one is refused
     * and rolls the change back as well.
     *
     * [block] is deliberately not `suspend`: nothing slow (HTTP calls, image or PDF work)
     * may run while the lock is held, and a nested audited write would deadlock on it.
     */
    suspend fun <T> auditedWrite(
        actor: SessionUser?,
        entityType: String,
        block: (DSLContext) -> Audited<T>,
    ): T {
        // Read here, in the caller's coroutine: the transaction below does not necessarily see its context.
        val request = currentCoroutineContext()[RequestContext]
        return withContext(NonCancellable + Dispatchers.IO) {
            DatabaseFactory.dsl.transactionCoroutine { config ->
                val tx = config.dsl()
                tx.execute(AUDIT_LOCK_SQL)
                val outcome = block(tx)
                appendRow(tx, actor, outcome.action, entityType, outcome.entityId, outcome.before, outcome.after, request)
                for (also in outcome.alsoRecorded) {
                    appendRow(tx, actor, also.action, entityType, also.entityId, also.before, also.after, request)
                }
                outcome.result
            }
        }
    }

    /** Same lock key as the original implementation. */
    private const val AUDIT_LOCK_SQL = "SELECT pg_advisory_xact_lock(42)"

    /**
     * Appends one hash-chained row (see [AuditHash]). Must run under [AUDIT_LOCK_SQL] in the caller's transaction.
     *
     * What the row says (action, actor, entity, time, before and after) is composed into **one text**, the payload, which is
     * hashed with a salt that is new for every row and **stored as that very text**: verification hashes what is stored and
     * never depends on a JSON or `jsonb` round trip. The columns `ts`, `actor_id`, `action`, `entity_type` and `entity_id`
     * repeat the payload for searching (verification checks that they agree with it); the table has no other column in which
     * readable content could sit. The project the row belongs to ([AuditProject]) is part of the row hash.
     *
     * A row that the application cannot write properly (no project for a row of a project, an entity type without a rule, a
     * snapshot that is not JSON) is an [AuditWriteException]: a mistake of the code, which rolls the whole change back.
     *
     * When the change is made on behalf of a request, the address and user agent of that request are written to
     * `audit_request_context` in the same transaction. They are deliberately not part of the row or its hash: they are
     * personal data and are deleted after twelve months, which the chain could not survive (decision D7).
     */
    private fun appendRow(
        tx: DSLContext,
        actor: SessionUser?,
        action: String,
        entityType: String,
        entityId: String,
        before: JsonElement?,
        after: JsonElement?,
        request: RequestContext?,
    ) {
        // Which project the row belongs to is decided before anything is written: a row that cannot be assigned fails the
        // whole transaction, change included.
        val projectId = AuditProject.of(entityType, entityId, before, after)

        // Previous hash (genesis for the first row)
        val prevHash = tx.select(AUDIT_LOG.ROW_HASH)
            .from(AUDIT_LOG)
            .orderBy(AUDIT_LOG.ID.desc())
            .limit(1)
            .fetchOne()
            ?.value1()
            ?: AuditHash.GENESIS_HASH

        // The timestamp is part of the payload, so it is stored explicitly with the same (millisecond) precision.
        val ts = OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MILLIS)
        val actorId = actor?.id?.toString()
        val payload = try {
            AuditHash.payloadV2(action, actorId, entityType, entityId, before, after, ts)
        } catch (e: IllegalArgumentException) {
            // Its message says what was wrong and nothing of the snapshot; the original is not passed on to the client either way.
            throw AuditWriteException("The audit payload of a row could not be written: ${e.message}", e)
        }
        val salt = AuditHash.newSalt()
        val rowHash = AuditHash.rowHashV2(prevHash, projectId, AuditHash.payloadDigestV2(salt, payload))

        val auditId = tx.insertInto(AUDIT_LOG)
            .set(AUDIT_LOG.HASH_VERSION, AuditHash.VERSION_2.toShort())
            .set(AUDIT_LOG.TS, ts)
            .set(AUDIT_LOG.ACTOR_ID, actorId)
            .set(AUDIT_LOG.ACTION, action)
            .set(AUDIT_LOG.ENTITY_TYPE, entityType)
            .set(AUDIT_LOG.ENTITY_ID, entityId)
            .set(AUDIT_LOG.PROJECT_ID, projectId)
            .set(AUDIT_LOG.PAYLOAD_TEXT, payload)
            .set(AUDIT_LOG.PAYLOAD_SALT, salt)
            .set(AUDIT_LOG.PREV_HASH, prevHash)
            .set(AUDIT_LOG.ROW_HASH, rowHash)
            .returning(AUDIT_LOG.ID)
            .fetchSingle()
            .id!!

        request?.let {
            tx.insertInto(AUDIT_REQUEST_CONTEXT)
                .set(AUDIT_REQUEST_CONTEXT.AUDIT_ID, auditId)
                .set(AUDIT_REQUEST_CONTEXT.IP, it.ip)
                .set(AUDIT_REQUEST_CONTEXT.USER_AGENT, it.userAgent)
                .execute()
        }
    }

    /** The most that [verifyChain] holds of the payloads of the rows in memory at once, unless told otherwise. */
    const val DEFAULT_MAX_BATCH_BYTES = 8L * 1024 * 1024

    /**
     * Walks the whole chain in id order and checks every row: the hash is recomputed from the **stored** payload, salt, project
     * and previous hash; the columns that repeat the payload must say what it says; and the project is worked out again from
     * the payload by the rule of [AuditProject] and must be the one the row names (a row of project A that says it belongs to
     * B, or to nobody, has right hashes and is found here). Every row's `prev_hash` must be the hash of the row before it.
     * Returns the first broken row, if any. The messages say what is wrong and nothing of the row.
     *
     * A payload can be large (a snapshot of an entry with long texts), so the rows are read in pieces of at most [batchSize]
     * rows **and** about [maxBatchBytes] of payload (one row at least): the size is asked first, then only that many rows are
     * read.
     *
     * With an [anchor] recorded earlier outside the database it also proves that the log still contains
     * that very row: a log that was emptied, cut short or rewritten up to the anchor fails even though
     * the rest of the chain is consistent. An anchor is `<id>:<row_hash>`.
     */
    fun verifyChain(
        tx: DSLContext,
        batchSize: Int = 1000,
        anchor: AuditAnchor? = null,
        maxBatchBytes: Long = DEFAULT_MAX_BATCH_BYTES,
    ): AuditVerifyResult {
        require(batchSize > 0 && maxBatchBytes > 0) { "a batch needs rows and bytes" }
        var expectedPrev = AuditHash.GENESIS_HASH
        var lastId = 0L
        var total = 0L
        var head: AuditAnchor? = null
        var anchorMatched = false
        val checkedAt = OffsetDateTime.now(ZoneOffset.UTC).toString()

        while (true) {
            // What the next rows weigh (their ids and the size of their payloads), then as many of them as the bound allows.
            val window = tx.select(AUDIT_LOG.ID, DSL.octetLength(AUDIT_LOG.PAYLOAD_TEXT))
                .from(AUDIT_LOG)
                .where(AUDIT_LOG.ID.gt(lastId))
                .orderBy(AUDIT_LOG.ID.asc())
                .limit(batchSize)
                .fetch()
            if (window.isEmpty()) break
            var bytes = 0L
            var upTo = lastId
            for (entry in window) {
                val size = (entry.value2() ?: 0).toLong()
                if (bytes > 0 && bytes + size > maxBatchBytes) break
                bytes += size
                upTo = entry.value1()!!
            }
            val rows = tx.selectFrom(AUDIT_LOG)
                .where(AUDIT_LOG.ID.gt(lastId).and(AUDIT_LOG.ID.le(upTo)))
                .orderBy(AUDIT_LOG.ID.asc())
                .fetch()
            if (rows.isEmpty()) break

            for (r in rows) {
                total++
                val id = r.get(AUDIT_LOG.ID)!!
                val prevHash = r.get(AUDIT_LOG.PREV_HASH)!!
                val storedHash = r.get(AUDIT_LOG.ROW_HASH)!!
                if (!AuditHash.hashesEqual(prevHash, expectedPrev)) {
                    return AuditVerifyResult(false, total, id, "prev_hash mismatch on id=$id", checkedAt, head)
                }
                val problem = checkRow(r, id, prevHash, storedHash)
                if (problem != null) {
                    return AuditVerifyResult(false, total, id, problem, checkedAt, head)
                }
                if (anchor != null && id == anchor.id) {
                    if (!AuditHash.hashesEqual(storedHash, anchor.rowHash)) {
                        return AuditVerifyResult(false, total, id, "anchor mismatch: row id=$id is not the row that was recorded", checkedAt, head)
                    }
                    anchorMatched = true
                }
                expectedPrev = storedHash
                lastId = id
                head = AuditAnchor(id, storedHash)
            }
        }
        if (anchor != null && !anchorMatched) {
            val have = head?.let { "rows up to id=${it.id}" } ?: "no rows"
            return AuditVerifyResult(
                false, total, null,
                "anchor row id=${anchor.id} is missing: rows were removed from the log (it has $have)",
                checkedAt, head
            )
        }
        return AuditVerifyResult(true, total, null, null, checkedAt, head)
    }

    /** The keys of a payload, exactly. */
    private val PAYLOAD_KEYS = setOf("action", "actorId", "after", "before", "entityId", "entityType", "ts")

    /**
     * One row: the digest of the **stored** payload text under the stored salt, then the hash of the row from its previous
     * hash, its project and that digest. Then the columns that repeat the payload must agree with it, because only the
     * payload is under the hash, and the project must be the one that the payload gives. Returns what is wrong with the row, or
     * null. The messages hold nothing of the row.
     */
    private fun checkRow(r: Record, id: Long, prevHash: String, storedHash: String): String? {
        val version = r.get(AUDIT_LOG.HASH_VERSION)!!.toInt()
        if (version != AuditHash.VERSION_2) return "unknown hash_version $version on id=$id"
        val text = r.get(AUDIT_LOG.PAYLOAD_TEXT)
        val salt = r.get(AUDIT_LOG.PAYLOAD_SALT)
        if (text == null || salt == null) return "row id=$id has no payload or no salt"
        val recomputed = try {
            AuditHash.rowHashV2(prevHash, r.get(AUDIT_LOG.PROJECT_ID), AuditHash.payloadDigestV2(salt, text))
        } catch (e: IllegalArgumentException) {
            return "row id=$id is malformed: ${e.message}"
        }
        if (!AuditHash.hashesEqual(recomputed, storedHash)) return "row_hash mismatch on id=$id"

        val payload = try {
            Json.parseToJsonElement(text) as? JsonObject
        } catch (e: SerializationException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        } ?: return "the payload of row id=$id is not a JSON object"
        if (payload.keys != PAYLOAD_KEYS) return "the payload of row id=$id does not have the keys of a payload"

        fun text(key: String): String? = (payload.getValue(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
        val columns = mapOf(
            "action" to (r.get(AUDIT_LOG.ACTION) to text("action")),
            "entity type" to (r.get(AUDIT_LOG.ENTITY_TYPE) to text("entityType")),
            "entity id" to (r.get(AUDIT_LOG.ENTITY_ID) to text("entityId")),
            // A missing actor is JSON null in the payload, which is not a string: text() gives null for it, like the column.
            "actor id" to (r.get(AUDIT_LOG.ACTOR_ID) to text("actorId")),
            "time" to (AuditHash.formatTs(r.get(AUDIT_LOG.TS)!!) to text("ts")),
        )
        for ((name, pair) in columns) {
            if (pair.first != pair.second) return "the $name of row id=$id does not match its payload"
        }
        if ((payload.getValue("actorId") is JsonNull) != (r.get(AUDIT_LOG.ACTOR_ID) == null)) {
            return "the actor id of row id=$id does not match its payload"
        }

        // The project: worked out from the payload by the rule that fills it when a row is written.
        val derived = try {
            AuditProject.ofPayload(payload)
        } catch (e: AuditWriteException) {
            return "the project of row id=$id cannot be told from its payload"
        }
        if (derived != r.get(AUDIT_LOG.PROJECT_ID)) return "the project of row id=$id does not match its payload"
        return null
    }
}

