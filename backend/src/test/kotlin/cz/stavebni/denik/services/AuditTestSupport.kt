package cz.stavebni.denik.services

import cz.stavebni.denik.domain.SessionUser
import kotlinx.serialization.json.JsonElement
import org.jooq.DSLContext
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.assertThrows

/**
 * Appends one audit row through the real write path ([AuditService.auditedWrite]: the same transaction, lock and hash chain as
 * every change of the application). [change] runs inside that transaction, before the row is written, like the change a
 * service makes.
 */
internal suspend fun appendTestAuditRow(
    actor: SessionUser?,
    action: String,
    entityId: String,
    entityType: String = "test",
    before: JsonElement? = null,
    after: JsonElement? = null,
    change: (DSLContext) -> Unit = {},
) {
    AuditService.auditedWrite(actor, entityType) { tx ->
        change(tx)
        AuditService.Audited(result = Unit, action = action, entityId = entityId, before = before, after = after)
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
