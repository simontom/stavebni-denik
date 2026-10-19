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
import org.jooq.Record
import java.util.UUID

/**
 * The write path: `auditedWrite` applies a change and appends its hash-chained row (version 2) in one transaction.
 * Tampering with a row, with the versions mixed, and a project's slice of the chain are in [AuditChainVerificationTest].
 */
class AuditServiceTest : BaseIntegrationTest() {

    private val genesis = AuditHash.GENESIS_HASH

    private fun snapshot(text: String): JsonElement = Json.parseToJsonElement(text)

    /** Recomputes the hash of a stored version 2 row from nothing but its stored columns, the way a verifier does. */
    private fun expectedHash(log: Record): String = AuditHash.rowHashV2(
        prevHash = log.get(AUDIT_LOG.PREV_HASH)!!,
        projectId = log.get(AUDIT_LOG.PROJECT_ID),
        payloadDigest = AuditHash.payloadDigestV2(log.get(AUDIT_LOG.PAYLOAD_SALT)!!, log.get(AUDIT_LOG.PAYLOAD_TEXT)!!),
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
    fun `auditedWrite appends a version 2 row whose payload is the text that was hashed, and nothing else holds content`() = runBlocking {
        val user = createTestUser()
        val before = snapshot("""{"state":"old","nested":{"b":1,"a":[1,2]}}""")
        val after = snapshot("""{"state":"nový č","nested":{"b":2,"a":[2,1]},"flag":true,"none":null}""")

        val result = AuditService.auditedWrite(user, "user") { _ ->
            AuditService.Audited(result = "success", action = "user.test", entityId = "123", before = before, after = after)
        }

        assertEquals("success", result)
        val logs = dsl.selectFrom(AUDIT_LOG).fetch()
        assertEquals(1, logs.size)
        val log = logs.first()

        assertEquals(2, log.get(AUDIT_LOG.HASH_VERSION)!!.toInt(), "every new row is written in version 2")
        assertEquals(user.id.toString(), log.get(AUDIT_LOG.ACTOR_ID))
        assertEquals("user.test", log.get(AUDIT_LOG.ACTION))
        assertEquals("user", log.get(AUDIT_LOG.ENTITY_TYPE))
        assertEquals("123", log.get(AUDIT_LOG.ENTITY_ID))
        assertEquals(genesis, log.get(AUDIT_LOG.PREV_HASH))
        assertNull(log.get(AUDIT_LOG.PROJECT_ID), "a user belongs to no project")
        assertTrue(Regex("[0-9a-f]{64}").matches(log.get(AUDIT_LOG.PAYLOAD_SALT)!!), "a salt of 32 bytes, as hex")

        // The payload says everything the row says: the snapshots (as written, not as jsonb would return them) and the envelope.
        val payload = log.auditPayload()
        assertEquals(setOf("action", "actorId", "after", "before", "entityId", "entityType", "ts"), payload.keys)
        assertEquals(before, payload["before"])
        assertEquals(after, payload["after"])
        assertEquals(
            AuditHash.payloadV2("user.test", user.id.toString(), "user", "123", before, after, log.get(AUDIT_LOG.TS)!!),
            log.get(AUDIT_LOG.PAYLOAD_TEXT),
            "the stored text is exactly what the writer composes from the row's own columns",
        )
        // Nothing readable sits outside the hash.
        assertNull(log.get(AUDIT_LOG.BEFORE))
        assertNull(log.get(AUDIT_LOG.AFTER))
        assertNull(log.get(AUDIT_LOG.IP))
        assertNull(log.get(AUDIT_LOG.USER_AGENT))

        assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a row of a project carries the project inside its hash`() = runBlocking {
        val user = createTestUser()
        val projectId = UUID.randomUUID()
        appendTestAuditRow(user, "report.test", "r1", entityType = "report", after = snapshot("""{"id":"r1","projectId":"$projectId"}"""))
        appendTestAuditRow(user, "project.test", projectId.toString(), entityType = "project", after = snapshot("""{"id":"$projectId"}"""))
        appendTestAuditRow(user, "user.test", "u1", entityType = "user", after = snapshot("""{"role":"BOSS"}"""))

        val rows = dsl.selectFrom(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch()
        assertEquals(listOf(projectId, projectId, null), rows.map { it.get(AUDIT_LOG.PROJECT_ID) })
        // The project is in the hash: the same row with another project id (or none) hashes to something else.
        val report = rows[0]
        val digest = AuditHash.payloadDigestV2(report.get(AUDIT_LOG.PAYLOAD_SALT)!!, report.get(AUDIT_LOG.PAYLOAD_TEXT)!!)
        assertEquals(report.get(AUDIT_LOG.ROW_HASH), AuditHash.rowHashV2(report.get(AUDIT_LOG.PREV_HASH)!!, projectId, digest))
        assertNotEquals(report.get(AUDIT_LOG.ROW_HASH), AuditHash.rowHashV2(report.get(AUDIT_LOG.PREV_HASH)!!, UUID.randomUUID(), digest))
        assertNotEquals(report.get(AUDIT_LOG.ROW_HASH), AuditHash.rowHashV2(report.get(AUDIT_LOG.PREV_HASH)!!, null, digest))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a row that cannot be given a project is refused, and the change is not made`() = runBlocking {
        val user = createTestUser()
        val projectId = UUID.randomUUID()
        val noProjectInSnapshot = snapshot("""{"id":"r1"}""")

        assertThrows<IllegalStateException> {
            appendTestAuditRow(user, "report.test", "r1", entityType = "report", after = noProjectInSnapshot) { tx -> insertProject(tx, projectId, user.id) }
        }
        assertThrows<IllegalStateException> {
            appendTestAuditRow(user, "invoice.test", "i1", entityType = "invoice", after = snapshot("""{"projectId":"$projectId"}"""))
        }

        assertEquals(0, dsl.fetchCount(PROJECTS, PROJECTS.ID.eq(projectId)), "a change whose row cannot be written is rolled back")
        assertEquals(0, dsl.fetchCount(AUDIT_LOG))
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
        assertEquals(projectId, log.get(AUDIT_LOG.PROJECT_ID))
        assertEquals(1, dsl.fetchCount(PROJECTS, PROJECTS.ID.eq(projectId)))
        assertNull(log.auditBeforeText(), "no before for a creation")
    }

    @Test
    fun `a row without snapshots is still hashed and chained`() = runBlocking {
        AuditService.auditedWrite(null, "user") { _ -> AuditService.Audited(Unit, "cli.test", "1") }

        val log = dsl.selectFrom(AUDIT_LOG).fetchOne()!!
        assertNull(log.get(AUDIT_LOG.ACTOR_ID), "a command-line action has no acting user")
        assertNull(log.auditBeforeText())
        assertNull(log.auditAfterText())
        assertEquals("null", log.auditPayload().getValue("actorId").toString())
        assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH))
    }

    @Test
    fun `no two rows share a salt, not even rows that say the same`() = runBlocking {
        val user = createTestUser()
        repeat(5) { appendTestAuditRow(user, action = "same", entityId = "1", after = snapshot("""{"n":1}""")) }

        val rows = dsl.selectFrom(AUDIT_LOG).fetch()
        assertEquals(5, rows.map { it.get(AUDIT_LOG.PAYLOAD_SALT) }.toSet().size)
        val digests = rows.map { AuditHash.payloadDigestV2(it.get(AUDIT_LOG.PAYLOAD_SALT)!!, it.get(AUDIT_LOG.PAYLOAD_TEXT)!!) }
        assertEquals(5, digests.toSet().size, "so a stub of one row says nothing about whether another row said the same")
    }

    @Test
    fun `what is stored is what was hashed, numbers included (a jsonb round trip would have changed them)`() = runBlocking {
        val user = createTestUser()
        // The premise of backlog M10: jsonb does not give back what it was given.
        assertEquals("""{"tiny": 0.0000001}""", dsl.fetchValue("""select '{"tiny":1e-7}'::jsonb::text"""))

        appendTestAuditRow(user, "n", "1", after = snapshot("""{"quantity":12.0,"tiny":1e-7,"big":123456789012345678901234567890}"""))

        val log = dsl.selectFrom(AUDIT_LOG).fetchOne()!!
        val text = log.get(AUDIT_LOG.PAYLOAD_TEXT)!!
        assertTrue(text.contains(""""big":123456789012345678901234567890,"quantity":12.0,"tiny":1e-7"""), text)
        assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH))
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `text that databases and encodings treat specially survives the round trip and verifies`() = runBlocking {
        val user = createTestUser()
        // A combining accent, an emoji, U+2028, a no-break space, a NUL, a backslash, a quote, a lone surrogate.
        val tricky = "Á 😀     a\u0000b \\ \" \uD800 ž"
        appendTestAuditRow(user, "t", "1", after = Json.parseToJsonElement(Json.encodeToString(JsonElement.serializer(), kotlinx.serialization.json.buildJsonObject {
            put("text", kotlinx.serialization.json.JsonPrimitive(tricky))
            put("č", kotlinx.serialization.json.JsonPrimitive("ž"))
        })))

        val log = dsl.selectFrom(AUDIT_LOG).fetchOne()!!
        val stored = log.get(AUDIT_LOG.PAYLOAD_TEXT)!!
        assertEquals(stored, String(stored.toByteArray(Charsets.UTF_8), Charsets.UTF_8), "nothing in the stored text is lost by encoding it")
        assertEquals(expectedHash(log), log.get(AUDIT_LOG.ROW_HASH))
        assertTrue(AuditService.verifyChain(dsl).ok)
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
            runBlocking { assertInjectedFailure { appendTestAuditRow(user, action = "never.written", entityId = "1") { tx -> insertProject(tx, dummyProjectId, user.id) } } }
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
                        entityId = "worker_${workerIdx}_step_$step",
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
        assertTrue(AuditService.verifyChain(dsl).ok)
    }
}
