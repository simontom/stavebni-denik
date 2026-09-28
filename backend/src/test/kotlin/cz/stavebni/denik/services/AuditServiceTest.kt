package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.security.MessageDigest
import java.util.UUID

class AuditServiceTest : BaseIntegrationTest() {

    private fun sha256(payload: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(payload.toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }

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

        val expectedHash = sha256("0000000000000000000000000000000000000000000000000000000000000000" + "project.test" + "project" + "123")
        assertEquals(expectedHash, log.get(AUDIT_LOG.ROW_HASH))
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
        val expectedHash2 = sha256(log1.get(AUDIT_LOG.ROW_HASH)!! + "step2" + "test" + "2")
        assertEquals(expectedHash2, log2.get(AUDIT_LOG.ROW_HASH))

        val expectedHash3 = sha256(log2.get(AUDIT_LOG.ROW_HASH)!! + "step3" + "test" + "3")
        assertEquals(expectedHash3, log3.get(AUDIT_LOG.ROW_HASH))
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
}
