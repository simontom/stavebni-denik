package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.jooq.JSONB
import org.jooq.Record
import java.util.UUID

/** The write path: `auditedWrite` applies a change and appends its hash-chained row in one transaction. */
class AuditServiceTest : BaseIntegrationTest() {

    private val genesis = "0000000000000000000000000000000000000000000000000000000000000000"

    private fun snapshot(text: String): JsonElement = Json.parseToJsonElement(text)

    /** Recomputes the canonical hash of a stored row (see AuditHash), snapshots included. */
    private fun expectedHash(log: Record): String = AuditHash.rowHash(
        action = log.get(AUDIT_LOG.ACTION)!!,
        entityType = log.get(AUDIT_LOG.ENTITY_TYPE)!!,
        entityId = log.get(AUDIT_LOG.ENTITY_ID)!!,
        actorId = log.get(AUDIT_LOG.ACTOR_ID),
        before = log.get(AUDIT_LOG.BEFORE)?.data()?.let { Json.parseToJsonElement(it) },
        after = log.get(AUDIT_LOG.AFTER)?.data()?.let { Json.parseToJsonElement(it) },
        ip = log.get(AUDIT_LOG.IP),
        userAgent = log.get(AUDIT_LOG.USER_AGENT),
        prevHash = log.get(AUDIT_LOG.PREV_HASH)!!,
        ts = log.get(AUDIT_LOG.TS)!!,
    )

    private fun insertProject(tx: org.jooq.DSLContext, id: UUID, siteManagerId: UUID) {
        tx.insertInto(PROJECTS)
            .set(PROJECTS.ID, id)
            .set(PROJECTS.NAME, "Rollback Project")
            .set(PROJECTS.ADDRESS, "Test Address")
            .set(PROJECTS.CADASTRALAREA, "Area")
            .set(PROJECTS.PARCELNUMBERS, "123")
            .set(PROJECTS.BUILDER, "Builder")
            .set(PROJECTS.CONTRACTOR, "Contractor")
            .set(PROJECTS.SITEMANAGERID, siteManagerId)
            .set(PROJECTS.UPDATEDAT, java.time.OffsetDateTime.now())
            .execute()
    }

    @Test
    fun `auditedWrite appends a row with the snapshots and establishes the genesis hash`() = runBlocking {
        val user = createTestUser()
        val before = snapshot("""{"state":"old","nested":{"b":1,"a":[1,2]}}""")
        val after = snapshot("""{"state":"nový č","nested":{"b":2,"a":[2,1]},"flag":true,"none":null}""")

        val result = AuditService.auditedWrite(user, "project") { _ ->
            AuditService.Audited(result = "success", action = "project.test", entityId = "123", before = before, after = after)
        }

        assertEquals("success", result)
        val logs = dsl.selectFrom(AUDIT_LOG).fetch()
        assertEquals(1, logs.size)
        val log = logs.first()

        assertEquals(user.id.toString(), log.get(AUDIT_LOG.ACTOR_ID))
        assertEquals("project.test", log.get(AUDIT_LOG.ACTION))
        assertEquals("project", log.get(AUDIT_LOG.ENTITY_TYPE))
        assertEquals("123", log.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(genesis, log.get(AUDIT_LOG.PREV_HASH))
        assertEquals(before, snapshot(log.get(AUDIT_LOG.BEFORE)!!.data()))
        assertEquals(after, snapshot(log.get(AUDIT_LOG.AFTER)!!.data()))
        assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH))
        assertTrue(AuditService.verifyChain(dsl).ok, "the hash covers the snapshots as the database returns them from jsonb")
    }

    @Test
    fun `a row can name an entity that the change itself created`() = runBlocking {
        val user = createTestUser()
        val projectId = UUID.randomUUID()

        AuditService.auditedWrite(user, "project") { tx ->
            insertProject(tx, projectId, user.id)
            AuditService.Audited(result = Unit, action = "project.test", entityId = projectId.toString(), after = snapshot("""{"id":"$projectId"}"""))
        }

        val log = dsl.selectFrom(AUDIT_LOG).fetchOne()!!
        assertEquals(projectId.toString(), log.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(1, dsl.fetchCount(PROJECTS, PROJECTS.ID.eq(projectId)))
        assertNull(log.get(AUDIT_LOG.BEFORE), "no before for a creation")
    }

    @Test
    fun `a row without snapshots is still hashed and chained`() = runBlocking {
        AuditService.auditedWrite(null, "test") { _ -> AuditService.Audited(Unit, "cli.test", "1") }

        val log = dsl.selectFrom(AUDIT_LOG).fetchOne()!!
        assertNull(log.get(AUDIT_LOG.ACTOR_ID), "a command-line action has no acting user")
        assertNull(log.get(AUDIT_LOG.BEFORE))
        assertNull(log.get(AUDIT_LOG.AFTER))
        assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH))
    }

    @Test
    fun `auditedWrite maintains cryptographic hash chaining across multiple entries`() = runBlocking {
        val user = createTestUser()

        appendTestAuditRow(user, action = "step1", entityId = "1", after = snapshot("""{"n":1}"""))
        appendTestAuditRow(user, action = "step2", entityId = "2", before = snapshot("""{"n":1}"""), after = snapshot("""{"n":2}"""))
        appendTestAuditRow(user, action = "step3", entityId = "3")

        val logs = dsl.selectFrom(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch()
        assertEquals(3, logs.size)

        val log1 = logs[0]
        val log2 = logs[1]
        val log3 = logs[2]

        assertEquals(genesis, log1.get(AUDIT_LOG.PREV_HASH))
        assertEquals(log1.get(AUDIT_LOG.ROW_HASH), log2.get(AUDIT_LOG.PREV_HASH))
        assertEquals(log2.get(AUDIT_LOG.ROW_HASH), log3.get(AUDIT_LOG.PREV_HASH))

        // Verify cryptographic integrity
        assertEquals(expectedHash(log1), log1.get(AUDIT_LOG.ROW_HASH))
        assertEquals(expectedHash(log2), log2.get(AUDIT_LOG.ROW_HASH))
        assertEquals(expectedHash(log3), log3.get(AUDIT_LOG.ROW_HASH))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `auditedWrite rolls back both business data and audit log when the change fails`() = runBlocking {
        val user = createTestUser()
        val dummyProjectId = UUID.randomUUID()

        assertThrows<IllegalStateException> {
            appendTestAuditRow(user, action = "fail.action", entityId = "999") { tx ->
                insertProject(tx, dummyProjectId, user.id)
                throw IllegalStateException("Intentional failure to trigger rollback")
            }
        }

        // Verify neither project nor audit log was committed
        assertEquals(0, dsl.fetchCount(PROJECTS, PROJECTS.ID.eq(dummyProjectId)))
        assertEquals(0, dsl.fetchCount(AUDIT_LOG))
    }

    @Test
    fun `auditedWrite rolls back the change when the audit row cannot be written`() = runBlocking {
        val user = createTestUser()
        val dummyProjectId = UUID.randomUUID()

        dsl.withFailingTrigger("audit_log", "INSERT") {
            assertThrows<Exception> {
                runBlocking { appendTestAuditRow(user, action = "never.written", entityId = "1") { tx -> insertProject(tx, dummyProjectId, user.id) } }
            }
        }

        assertEquals(0, dsl.fetchCount(PROJECTS, PROJECTS.ID.eq(dummyProjectId)), "a change without its audit row is not made")
        assertEquals(0, dsl.fetchCount(AUDIT_LOG))
    }

    @Test
    fun `auditedWrite maintains cryptographic integrity under high concurrency with advisory locks`() = runBlocking {
        val user = createTestUser()
        val concurrency = 10
        val operationsPerCoroutine = 4
        val totalOperations = concurrency * operationsPerCoroutine

        val jobs = (1..concurrency).map { workerIdx ->
            async(Dispatchers.Default) {
                for (step in 1..operationsPerCoroutine) {
                    appendTestAuditRow(
                        user,
                        action = "concurrent.action",
                        entityId = "step_$step",
                        entityType = "worker_$workerIdx",
                        after = snapshot("""{"worker":$workerIdx,"step":$step}"""),
                    )
                }
            }
        }

        jobs.awaitAll()

        val logs = dsl.selectFrom(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch()
        assertEquals(totalOperations, logs.size)

        var expectedPrevHash = genesis
        for (log in logs) {
            val actualPrevHash = log.get(AUDIT_LOG.PREV_HASH)
            assertEquals(expectedPrevHash, actualPrevHash, "Chain broken at log ID ${log.get(AUDIT_LOG.ID)}")

            assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH), "Hash mismatch at log ID ${log.get(AUDIT_LOG.ID)}")

            expectedPrevHash = log.get(AUDIT_LOG.ROW_HASH)!!
        }
    }

    /** What an attacker with DDL rights can do: the append-only trigger blocks UPDATEs, so switch it off for a moment. */
    private fun tamper(update: () -> Unit) {
        dsl.execute("ALTER TABLE \"audit_log\" DISABLE TRIGGER audit_log_no_update")
        try {
            update()
        } finally {
            dsl.execute("ALTER TABLE \"audit_log\" ENABLE TRIGGER audit_log_no_update")
        }
    }

    @Test
    fun `verifyChain detects a tampered row`() = runBlocking {
        val user = createTestUser()
        appendTestAuditRow(user, action = "a1", entityId = "1")
        appendTestAuditRow(user, action = "a2", entityId = "2")
        appendTestAuditRow(user, action = "a3", entityId = "3")

        val intact = AuditService.verifyChain(dsl)
        assertTrue(intact.ok)
        assertEquals(3L, intact.totalRows)

        val secondId = dsl.select(AUDIT_LOG.ID).from(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).offset(1).limit(1).fetchOne()!!.value1()!!
        tamper { dsl.update(AUDIT_LOG).set(AUDIT_LOG.ENTITY_ID, "tampered").where(AUDIT_LOG.ID.eq(secondId)).execute() }

        val broken = AuditService.verifyChain(dsl)
        assertFalse(broken.ok)
        assertEquals(secondId, broken.brokenAtId)
    }

    @Test
    fun `verifyChain detects a changed snapshot`() = runBlocking {
        val user = createTestUser()
        appendTestAuditRow(user, action = "user.update", entityId = "1", entityType = "user", before = snapshot("""{"role":"WORKER"}"""), after = snapshot("""{"role":"BOSS"}"""))
        appendTestAuditRow(user, action = "a2", entityId = "2")
        assertTrue(AuditService.verifyChain(dsl).ok)

        val firstId = dsl.select(AUDIT_LOG.ID).from(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).limit(1).fetchOne()!!.value1()!!
        tamper { dsl.update(AUDIT_LOG).set(AUDIT_LOG.AFTER, JSONB.jsonb("""{"role":"WORKER"}""")).where(AUDIT_LOG.ID.eq(firstId)).execute() }

        val broken = AuditService.verifyChain(dsl)
        assertFalse(broken.ok, "what a row says a user became is covered by its hash")
        assertEquals(firstId, broken.brokenAtId)
    }
}
