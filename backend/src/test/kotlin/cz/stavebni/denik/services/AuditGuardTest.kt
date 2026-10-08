package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.cli.AdminCli
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** The audit log cannot be truncated, and a recorded head proves that nothing was cut off. */
class AuditGuardTest : BaseIntegrationTest() {

    private fun append(user: SessionUser, count: Int, from: Int = 1) = runBlocking {
        for (i in from until from + count) {
            AuditService.auditedTransaction(actor = user, action = "a$i", entityType = "test", entityId = "$i") { i }
        }
    }

    private fun count() = dsl.fetchCount(AUDIT_LOG)

    /** What an attacker with ownership of the table can do: switch a guard off, act, switch it on again. */
    private fun withTriggerOff(trigger: String, action: () -> Unit) {
        dsl.execute("ALTER TABLE \"audit_log\" DISABLE TRIGGER $trigger")
        try {
            action()
        } finally {
            dsl.execute("ALTER TABLE \"audit_log\" ENABLE TRIGGER $trigger")
        }
    }

    // --- TRUNCATE -------------------------------------------------------------------------------

    @Test
    fun `the audit log cannot be truncated, not even by the owner of the table`() {
        append(createTestUser(), 3)

        val error = assertThrows<DataAccessException> { dsl.execute("TRUNCATE TABLE \"audit_log\"") }
        assertTrue(error.message!!.contains("cannot be truncated"), error.message)
        assertThrows<DataAccessException> { dsl.execute("TRUNCATE TABLE \"audit_log\" RESTART IDENTITY CASCADE") }

        assertEquals(3, count())
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `truncating other tables leaves the audit log alone`() {
        append(createTestUser(), 2)

        dsl.execute("TRUNCATE TABLE \"users\" CASCADE")

        assertEquals(0, dsl.fetchCount(USERS))
        assertEquals(2, count() , "the audit rows of the removed users are still there")
    }

    @Test
    fun `rows still cannot be updated or deleted`() {
        append(createTestUser(), 2)

        assertThrows<DataAccessException> { dsl.execute("DELETE FROM \"audit_log\"") }
        assertThrows<DataAccessException> { dsl.execute("UPDATE \"audit_log\" SET \"entity_id\" = 'x'") }
        assertEquals(2, count())
    }

    // --- anchors --------------------------------------------------------------------------------

    @Test
    fun `an anchor stays valid while the log grows`() {
        val user = createTestUser()
        append(user, 3)
        val anchor = AuditService.verifyChain(dsl).head!!
        assertEquals(3L, anchor.id)

        append(user, 2, from = 4)

        val result = AuditService.verifyChain(dsl, anchor = anchor)
        assertTrue(result.ok, result.reason)
        assertEquals(5L, result.totalRows)
        assertEquals(5L, result.head!!.id)
    }

    @Test
    fun `cutting off the newest rows keeps the chain valid but not the anchor`() {
        val user = createTestUser()
        append(user, 5)
        val anchor = AuditService.verifyChain(dsl).head!!
        withTriggerOff("audit_log_no_delete") { dsl.execute("DELETE FROM \"audit_log\" WHERE \"id\" > 3") }

        // The limit of the chain alone: what is left is internally consistent ...
        assertTrue(AuditService.verifyChain(dsl).ok)
        // ... the recorded head is what shows that something is gone.
        val result = AuditService.verifyChain(dsl, anchor = anchor)
        assertFalse(result.ok)
        assertTrue(result.reason!!.contains("anchor row id=5 is missing"), result.reason)
        assertTrue(result.reason!!.contains("up to id=3"), result.reason)
    }

    @Test
    fun `a wiped log is detected by the anchor`() {
        val user = createTestUser()
        append(user, 3)
        val anchor = AuditService.verifyChain(dsl).head!!
        withTriggerOff("audit_log_no_truncate") { dsl.execute("TRUNCATE TABLE \"audit_log\"") }

        assertTrue(AuditService.verifyChain(dsl).ok, "an empty chain is valid on its own")
        val result = AuditService.verifyChain(dsl, anchor = anchor)
        assertFalse(result.ok)
        assertTrue(result.reason!!.contains("no rows"), result.reason)
    }

    @Test
    fun `a row id that carries a different hash than the recorded one is detected`() {
        append(createTestUser(), 3)
        val real = AuditService.verifyChain(dsl).head!!

        val forged = AuditService.verifyChain(dsl, anchor = AuditAnchor(real.id, "0".repeat(real.rowHash.length)))

        assertFalse(forged.ok)
        assertEquals(real.id, forged.brokenAtId)
        assertTrue(forged.reason!!.contains("anchor mismatch"), forged.reason)
    }

    @Test
    fun `an empty log with no anchor is fine, the head of an empty log is null`() {
        val result = AuditService.verifyChain(dsl)

        assertTrue(result.ok)
        assertEquals(0L, result.totalRows)
        assertNull(result.head)
    }

    @Test
    fun `anchors are written and read as id and hash`() {
        val anchor = AuditAnchor(42, "ab12CD")

        assertEquals("42:ab12CD", anchor.toString())
        assertEquals(anchor, AuditAnchor.parse(" 42:ab12CD "))
        assertNull(AuditAnchor.parse("42"))
        assertNull(AuditAnchor.parse("x:abc"))
        assertNull(AuditAnchor.parse("42:"))
        assertNull(AuditAnchor.parse("42:not a hash!"))
    }

    // --- the admin API --------------------------------------------------------------------------

    @Test
    fun `the verify endpoint reports the head and checks an anchor`() = testApplication {
        application { module() }
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        append(admin, 3)
        val token = generateJwtToken(admin)
        val head = AuditService.verifyChain(dsl).head!!
        // The login above and every audited call add rows; the anchor stays valid.
        val plain = client.get("/api/audit/verify") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.OK, plain.status, plain.bodyAsText())
        assertTrue(Json.parseToJsonElement(plain.bodyAsText()).jsonObject["head"]!!.jsonObject["id"]!!.jsonPrimitive.content.toLong() >= head.id)

        val anchored = client.get("/api/audit/verify?anchor=$head") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.OK, anchored.status)
        assertTrue(anchored.bodyAsText().contains("\"ok\":true"), anchored.bodyAsText())

        val wrong = client.get("/api/audit/verify?anchor=${head.id + 100}:${head.rowHash}") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.OK, wrong.status)
        assertTrue(wrong.bodyAsText().contains("\"ok\":false"), wrong.bodyAsText())

        val malformed = client.get("/api/audit/verify?anchor=nonsense") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.BadRequest, malformed.status)
    }

    @Test
    fun `only an administrator can verify`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)

        val response = client.get("/api/audit/verify") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}") }

        assertEquals(HttpStatusCode.Forbidden, response.status)
    }

    // --- the command line -----------------------------------------------------------------------

    private class Run(val code: Int, val out: List<String>, val err: List<String>)

    private fun cli(vararg args: String): Run {
        val out = mutableListOf<String>()
        val err = mutableListOf<String>()
        return Run(AdminCli.run(args.toList(), out::add, err::add), out, err)
    }

    @Test
    fun `audit-head prints the anchor and nothing else`() {
        append(createTestUser(), 3)

        val run = cli("audit-head")

        assertEquals(0, run.code, run.err.toString())
        assertEquals(listOf(AuditService.verifyChain(dsl).head.toString()), run.out)
        assertTrue(run.err.isEmpty())
        assertTrue(run.out.single().startsWith("3:"), "the head of three rows is row 3: ${run.out}")
    }

    @Test
    fun `audit-head of an empty log is a failure`() {
        val run = cli("audit-head")

        assertEquals(1, run.code)
        assertTrue(run.err.single().contains("empty"))
        assertTrue(run.out.isEmpty())
    }

    @Test
    fun `audit-verify passes, checks an anchor, and fails on a cut log`() {
        val user = createTestUser()
        append(user, 5)
        val anchor = cli("audit-head").out.single()

        val plain = cli("audit-verify")
        assertEquals(0, plain.code, plain.err.toString())
        assertTrue(plain.out.single().startsWith("Audit log OK: 5 rows"))

        val anchored = cli("audit-verify", anchor)
        assertEquals(0, anchored.code, anchored.err.toString())
        assertTrue(anchored.out.last().contains("found unchanged"))

        withTriggerOff("audit_log_no_delete") { dsl.execute("DELETE FROM \"audit_log\" WHERE \"id\" > 3") }
        assertEquals(0, cli("audit-verify").code, "without an anchor a cut tail cannot be seen")
        val cut = cli("audit-verify", anchor)
        assertEquals(1, cut.code)
        assertTrue(cut.err.single().startsWith("Audit log BROKEN:"), cut.err.toString())
        assertTrue(cut.out.isEmpty())
    }

    @Test
    fun `an anchor that is not id and hash is a usage error`() {
        for (args in listOf(arrayOf("audit-verify", "nonsense"), arrayOf("audit-verify", "1", "2"), arrayOf("audit-head", "x"))) {
            val run = cli(*args)
            assertEquals(2, run.code, args.toList().toString())
            assertTrue(run.err.single().contains("Usage:"))
        }
        assertFalse(AdminCli.hasValidShape(listOf("audit-verify", "nonsense")))
        assertTrue(AdminCli.hasValidShape(listOf("audit-verify", "7:abc")))
    }
}
