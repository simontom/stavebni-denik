package cz.stavebni.denik.services

import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.jooq.DSLContext
import org.jooq.Record
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.UUID

/**
 * Appends one audit row through the real write path ([AuditService.auditedWrite]: the same transaction, lock and hash chain as
 * every change of the application). [change] runs inside that transaction, before the row is written, like the change a
 * service makes.
 *
 * The default entity type is a user: such a row belongs to no project. A row of any other entity type has to say which
 * project it belongs to (see [AuditProject]), like the rows of the services do.
 */
internal suspend fun appendTestAuditRow(
    actor: SessionUser?,
    action: String,
    entityId: String,
    entityType: String = "user",
    before: JsonElement? = null,
    after: JsonElement? = null,
    change: (DSLContext) -> Unit = {},
) {
    // An action belongs to its entity type (`report.lock` is a row of type `report`): a bare name is given the prefix.
    val named = if (action.startsWith("$entityType.")) action else "$entityType.$action"
    AuditService.auditedWrite(actor, entityType) { tx ->
        change(tx)
        AuditService.Audited(result = Unit, action = named, entityId = entityId, before = before, after = after)
    }
}

/**
 * Appends a row that is **valid in every way except that it names the project [projectId] it is told to**, not the one its
 * payload says: what somebody with the right to insert into `audit_log` (a stolen application password, or a bug) can write
 * past [AuditService.auditedWrite]. Its hashes are right and it continues the chain, so only a check of the project against
 * the payload can find it. Tests are sequential, so nothing writes to the chain at the same moment. Returns the row's id.
 */
internal fun DSLContext.insertRowNamingProject(
    projectId: UUID?,
    action: String,
    entityId: String,
    entityType: String,
    before: JsonElement? = null,
    after: JsonElement? = null,
    actorId: String? = null,
): Long {
    val ts = OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MILLIS)
    return insertRowWithPayload(
        AuditHash.payloadV2(action, actorId, entityType, entityId, before, after, ts), ts, projectId, action, entityId, entityType, actorId,
    )
}

/**
 * Appends a row whose payload text is **given as it is** (not composed by [AuditHash.payloadV2], which refuses what a writer
 * must not write): valid hashes, the chain continued. What somebody with the right to insert can write past the application,
 * for example a payload nested a hundred thousand levels deep. Returns the row's id.
 */
internal fun DSLContext.insertRowWithPayload(
    payload: String,
    ts: OffsetDateTime,
    projectId: UUID?,
    action: String,
    entityId: String,
    entityType: String,
    actorId: String? = null,
): Long {
    val prevHash = select(AUDIT_LOG.ROW_HASH).from(AUDIT_LOG).orderBy(AUDIT_LOG.ID.desc()).limit(1).fetchOne()?.value1() ?: AuditHash.GENESIS_HASH
    val salt = AuditHash.newSalt()
    return insertInto(AUDIT_LOG)
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
        .set(AUDIT_LOG.ROW_HASH, AuditHash.rowHashV2(prevHash, projectId, AuditHash.payloadDigestV2(salt, payload)))
        .returning(AUDIT_LOG.ID)
        .fetchSingle()
        .id!!
}

/** The payload of a row, the text its hash covers, as an object. Needs `payload_text` among the columns read. */
internal fun Record.auditPayload(): JsonObject = Json.parseToJsonElement(get(AUDIT_LOG.PAYLOAD_TEXT)!!).jsonObject

private fun Record.auditPart(name: String): String? =
    auditPayload().getValue(name).takeUnless { it is JsonNull }?.let { Json.encodeToString(JsonElement.serializer(), it) }

/** What the row says the entity was before the change, as JSON text (null for a creation). Read from the payload. */
internal fun Record.auditBeforeText(): String? = auditPart("before")

/** What the row says the entity became, as JSON text (null for a removal). Read from the payload. */
internal fun Record.auditAfterText(): String? = auditPart("after")

/** The before or after (`part`) of the one row of [action], as JSON text. */
internal fun DSLContext.auditPartOf(action: String, part: String): String? =
    select(AUDIT_LOG.PAYLOAD_TEXT).from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).fetchSingle().auditPayload().getValue(part)
        .takeUnless { it is JsonNull }?.let { Json.encodeToString(JsonElement.serializer(), it) }

/**
 * Runs [body] with the CHECK constraint [name] of [table] (`audit_log` unless said otherwise) taken off, then puts it back exactly as it was: the way to show
 * what the verification does with a row that the database itself would have refused (an attacker who owns the table can drop
 * a constraint, like a trigger).
 */
internal fun DSLContext.withoutConstraint(name: String, table: String = "audit_log", body: () -> Unit) {
    val definition = (fetchValue("select pg_get_constraintdef(oid) from pg_constraint where conname = ?", name) as String)
        .removeSuffix(" NOT VALID")
    execute("ALTER TABLE \"$table\" DROP CONSTRAINT \"$name\"")
    try {
        body()
    } finally {
        // NOT VALID: the rows the test damaged are still there, and the constraint binds every row written from now on.
        execute("ALTER TABLE \"$table\" ADD CONSTRAINT \"$name\" $definition NOT VALID")
    }
}

/**
 * Makes every write of [event] (`INSERT`, `UPDATE`) on [table] fail while [body] runs, then removes the trigger again: a way to
 * make a step of a transaction fail after the steps before it were made. Tests share one database and run one after another.
 */
internal fun DSLContext.withFailingTrigger(table: String, event: String, body: () -> Unit) {
    execute("CREATE OR REPLACE FUNCTION test_always_fails() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test: this write must fail''; END;'")
    execute("CREATE TRIGGER test_always_fails BEFORE $event ON \"$table\" FOR EACH ROW EXECUTE FUNCTION test_always_fails()")
    try {
        body()
    } finally {
        execute("DROP TRIGGER test_always_fails ON \"$table\"")
        execute("DROP FUNCTION test_always_fails()")
    }
}

/**
 * Runs [body], which has to fail with the database error that [withFailingTrigger] injects (a [DataAccessException] that names
 * it): any other exception, such as a refusal by the application's own checks, does not count as the injected failure.
 */
internal suspend fun assertInjectedFailure(body: suspend () -> Unit) {
    val error = assertThrows<DataAccessException> { body() }
    assertTrue(error.message!!.contains("this write must fail"), "not the failure that was injected: ${error.message}")
}
