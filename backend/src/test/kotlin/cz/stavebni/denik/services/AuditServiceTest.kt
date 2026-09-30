package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.jooq.Record
import java.util.UUID

class AuditServiceTest : BaseIntegrationTest() {

    /** Recomputes the canonical hash of a stored row (see AuditHash). */
    private fun expectedHash(log: Record): String = AuditHash.rowHash(
        action = log.get(AUDIT_LOG.ACTION)!!,
        entityType = log.get(AUDIT_LOG.ENTITY_TYPE)!!,
        entityId = log.get(AUDIT_LOG.ENTITY_ID)!!,
        actorId = log.get(AUDIT_LOG.ACTOR_ID),
        before = null,
        after = null,
        ip = log.get(AUDIT_LOG.IP),
        userAgent = log.get(AUDIT_LOG.USER_AGENT),
        prevHash = log.get(AUDIT_LOG.PREV_HASH)!!,
        ts = log.get(AUDIT_LOG.TS)!!,
    )

    @Test
    fun `auditedTransaction inserts log and establishes genesis hash`() = runBlocking {
        val user = createTestUser()

        val result = AuditService.auditedTransaction(
            actor = user,
            action = "project.test",
            entityType = "project",
            entityId = "123"
        ) { tx ->
            "success"
        }

        assertEquals("success", result)

        val logs = dsl.selectFrom(AUDIT_LOG).fetch()
        assertEquals(1, logs.size)
        val log = logs.first()

        assertEquals(user.id.toString(), log.get(AUDIT_LOG.ACTOR_ID))
        assertEquals("project.test", log.get(AUDIT_LOG.ACTION))
        assertEquals("project", log.get(AUDIT_LOG.ENTITY_TYPE))
        assertEquals("123", log.get(AUDIT_LOG.ENTITY_ID))
        assertEquals("0000000000000000000000000000000000000000000000000000000000000000", log.get(AUDIT_LOG.PREV_HASH))

        assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH))
    }

    @Test
    fun `auditedTransaction maintains cryptographic hash chaining across multiple entries`() = runBlocking {
        val user = createTestUser()

        AuditService.auditedTransaction(actor = user, action = "step1", entityType = "test", entityId = "1") { 1 }
        AuditService.auditedTransaction(actor = user, action = "step2", entityType = "test", entityId = "2") { 2 }
        AuditService.auditedTransaction(actor = user, action = "step3", entityType = "test", entityId = "3") { 3 }

        val logs = dsl.selectFrom(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch()
        assertEquals(3, logs.size)

        val log1 = logs[0]
        val log2 = logs[1]
        val log3 = logs[2]

        assertEquals("0000000000000000000000000000000000000000000000000000000000000000", log1.get(AUDIT_LOG.PREV_HASH))
        assertEquals(log1.get(AUDIT_LOG.ROW_HASH), log2.get(AUDIT_LOG.PREV_HASH))
        assertEquals(log2.get(AUDIT_LOG.ROW_HASH), log3.get(AUDIT_LOG.PREV_HASH))

        // Verify cryptographic integrity
        assertEquals(expectedHash(log2), log2.get(AUDIT_LOG.ROW_HASH))
        assertEquals(expectedHash(log3), log3.get(AUDIT_LOG.ROW_HASH))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `auditedTransaction rolls back both business data and audit log on failure`() = runBlocking {
        val user = createTestUser()
        val dummyProjectId = UUID.randomUUID()

        assertThrows<IllegalStateException> {
            runBlocking {
                AuditService.auditedTransaction(actor = user, action = "fail.action", entityType = "test", entityId = "999") { tx ->
                    tx.insertInto(PROJECTS)
                        .set(PROJECTS.ID, dummyProjectId)
                        .set(PROJECTS.NAME, "Rollback Project")
                        .set(PROJECTS.ADDRESS, "Test Address")
                        .set(PROJECTS.CADASTRALAREA, "Area")
                        .set(PROJECTS.PARCELNUMBERS, "123")
                        .set(PROJECTS.BUILDER, "Builder")
                        .set(PROJECTS.CONTRACTOR, "Contractor")
                        .set(PROJECTS.SITEMANAGERID, user.id)
                        .set(PROJECTS.UPDATEDAT, java.time.OffsetDateTime.now())
                        .execute()

                    throw IllegalStateException("Intentional failure to trigger rollback")
                }
            }
        }

        // Verify neither project nor audit log was committed
        val projectCount = dsl.selectCount().from(PROJECTS).where(PROJECTS.ID.eq(dummyProjectId)).fetchOne(0, Int::class.java)
        assertEquals(0, projectCount)

        val logCount = dsl.selectCount().from(AUDIT_LOG).fetchOne(0, Int::class.java)
        assertEquals(0, logCount)
    }

    @Test
    fun `auditedTransaction maintains cryptographic integrity under high concurrency with advisory locks`() = runBlocking {
        val user = createTestUser()
        val concurrency = 10
        val operationsPerCoroutine = 4
        val totalOperations = concurrency * operationsPerCoroutine

        val jobs = (1..concurrency).map { workerIdx ->
            async(Dispatchers.Default) {
                for (step in 1..operationsPerCoroutine) {
                    AuditService.auditedTransaction(
                        actor = user,
                        action = "concurrent.action",
                        entityType = "worker_$workerIdx",
                        entityId = "step_$step"
                    ) { tx ->
                        step
                    }
                }
            }
        }

        jobs.awaitAll()

        val logs = dsl.selectFrom(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch()
        assertEquals(totalOperations, logs.size)

        var expectedPrevHash = "0000000000000000000000000000000000000000000000000000000000000000"
        for (log in logs) {
            val actualPrevHash = log.get(AUDIT_LOG.PREV_HASH)
            assertEquals(expectedPrevHash, actualPrevHash, "Chain broken at log ID ${log.get(AUDIT_LOG.ID)}")

            assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH), "Hash mismatch at log ID ${log.get(AUDIT_LOG.ID)}")

            expectedPrevHash = log.get(AUDIT_LOG.ROW_HASH)!!
        }
    }

    @Test
    fun `verifyChain detects a tampered row`() = runBlocking {
        val user = createTestUser()
        AuditService.auditedTransaction(actor = user, action = "a1", entityType = "test", entityId = "1") { 1 }
        AuditService.auditedTransaction(actor = user, action = "a2", entityType = "test", entityId = "2") { 2 }
        AuditService.auditedTransaction(actor = user, action = "a3", entityType = "test", entityId = "3") { 3 }

        val intact = AuditService.verifyChain(dsl)
        assertTrue(intact.ok)
        assertEquals(3L, intact.totalRows)

        val secondId = dsl.select(AUDIT_LOG.ID).from(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).offset(1).limit(1).fetchOne()!!.value1()!!
        // The append-only trigger blocks UPDATEs; bypass it the way an attacker with DDL rights would.
        dsl.execute("ALTER TABLE \"audit_log\" DISABLE TRIGGER audit_log_no_update")
        try {
            dsl.update(AUDIT_LOG).set(AUDIT_LOG.ENTITY_ID, "tampered").where(AUDIT_LOG.ID.eq(secondId)).execute()
        } finally {
            dsl.execute("ALTER TABLE \"audit_log\" ENABLE TRIGGER audit_log_no_update")
        }

        val broken = AuditService.verifyChain(dsl)
        assertFalse(broken.ok)
        assertEquals(secondId, broken.brokenAtId)
    }
}
