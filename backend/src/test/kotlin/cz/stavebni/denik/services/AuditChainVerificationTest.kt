package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.jooq.JSONB
import org.jooq.Record
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/**
 * `verifyChain` over the two row formats: what it detects, how it treats rows of the old format (version 1) next to new
 * ones, and that a project's part of the chain, with the rest as stubs, verifies on its own.
 */
class AuditChainVerificationTest : BaseIntegrationTest() {

    private val genesis = AuditHash.GENESIS_HASH
    private val projectA = UUID.fromString("01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0e")
    private val projectB = UUID.fromString("01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0f")

    private fun snapshot(text: String): JsonElement = Json.parseToJsonElement(text)

    /** What an attacker with ownership of the table can do: switch a guard off, act, switch it on again. */
    private fun withTriggerOff(trigger: String, action: () -> Unit) {
        dsl.execute("ALTER TABLE \"audit_log\" DISABLE TRIGGER $trigger")
        try {
            action()
        } finally {
            dsl.execute("ALTER TABLE \"audit_log\" ENABLE TRIGGER $trigger")
        }
    }

    private fun tamper(sql: String) = withTriggerOff("audit_log_no_update") { dsl.execute(sql) }

    private fun rows(): List<Record> = dsl.selectFrom(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch().toList()

    /** Three rows of the chain: two of project A (an entry and its signature) and one of a user. Returns their ids. */
    private fun threeRows(): List<Long> = runBlocking {
        val user = createTestUser()
        appendTestAuditRow(user, "report.create", "r1", entityType = "report", after = snapshot("""{"id":"r1","projectId":"$projectA","n":1}"""))
        appendTestAuditRow(
            user, "report.lock", "r1", entityType = "report",
            before = snapshot("""{"id":"r1","projectId":"$projectA","n":1}"""), after = snapshot("""{"id":"r1","projectId":"$projectA","n":2}"""),
        )
        appendTestAuditRow(user, "user.update", "u1", entityType = "user", before = snapshot("""{"role":"WORKER"}"""), after = snapshot("""{"role":"BOSS"}"""))
        rows().map { it.get(AUDIT_LOG.ID)!! }
    }

    private fun assertBrokenAt(id: Long, what: String, reasonContains: String? = null) {
        val result = AuditService.verifyChain(dsl)
        assertFalse(result.ok, "$what must be detected")
        assertEquals(id, result.brokenAtId, "$what: the first damaged row")
        if (reasonContains != null) assertTrue(result.reason!!.contains(reasonContains), "$what: ${result.reason}")
    }

    // --- version 2: any change of a row is detected --------------------------------------------------------------------------

    private val otherSalt = "a".repeat(64)

    @Test
    fun `a change of any part of a version 2 row is detected at that row`() {
        val changes: Map<String, (Long) -> String> = linkedMapOf(
            "one byte of the payload" to { id -> "update audit_log set payload_text = replace(payload_text, '\"n\":2', '\"n\":3') where id = $id" },
            "a character of the payload's text" to { id -> "update audit_log set payload_text = replace(payload_text, 'report.lock', 'report.lock ') where id = $id" },
            "the salt" to { id -> "update audit_log set payload_salt = '$otherSalt' where id = $id" },
            "the project, to another project" to { id -> "update audit_log set project_id = '$projectB' where id = $id" },
            "the project, removed" to { id -> "update audit_log set project_id = null where id = $id" },
            "the version, 2 written as 1" to { id -> "update audit_log set hash_version = 1, project_id = null, payload_text = null, payload_salt = null where id = $id" },
            "the stored row hash" to { id -> "update audit_log set row_hash = '${"b".repeat(64)}' where id = $id" },
        )
        for ((what, sql) in changes) {
            clearTables()
            val ids = threeRows()
            tamper(sql(ids[1]))
            assertBrokenAt(ids[1], what)
        }
    }

    @Test
    fun `the previous hash of a row cannot be changed either`() {
        val ids = threeRows()
        tamper("update audit_log set prev_hash = '${"c".repeat(64)}' where id = ${ids[1]}")
        assertBrokenAt(ids[1], "a changed prev_hash", "prev_hash mismatch on id=${ids[1]}")
    }

    @Test
    fun `the columns that repeat the payload must agree with it`() {
        // The hash covers the payload, so a column that only repeats it (for searching) would otherwise be free to lie.
        val changes: Map<String, (Long) -> String> = linkedMapOf(
            "the action" to { id -> "update audit_log set action = 'report.delete' where id = $id" },
            "the entity type" to { id -> "update audit_log set entity_type = 'photo' where id = $id" },
            "the entity" to { id -> "update audit_log set entity_id = 'r2' where id = $id" },
            "the actor, to another" to { id -> "update audit_log set actor_id = '${UUID.randomUUID()}' where id = $id" },
            "the actor, removed" to { id -> "update audit_log set actor_id = null where id = $id" },
            "the time" to { id -> "update audit_log set ts = ts + interval '1 millisecond' where id = $id" },
        )
        for ((what, sql) in changes) {
            clearTables()
            val ids = threeRows()
            assertTrue(AuditService.verifyChain(dsl).ok)
            tamper(sql(ids[1]))
            assertBrokenAt(ids[1], what, "does not match its payload")
        }
    }

    @Test
    fun `a row that is removed, or two rows that swap places, break the chain`() {
        val ids = threeRows()
        withTriggerOff("audit_log_no_delete") { dsl.execute("delete from audit_log where id = ${ids[1]}") }
        assertBrokenAt(ids[2], "a removed row", "prev_hash mismatch")

        clearTables()
        val again = threeRows()
        // Swap the numbers of the second and the third row: the chain is read in order.
        withTriggerOff("audit_log_no_update") {
            dsl.execute("update audit_log set id = 1000 where id = ${again[1]}")
            dsl.execute("update audit_log set id = ${again[1]} where id = ${again[2]}")
            dsl.execute("update audit_log set id = ${again[2]} where id = 1000")
        }
        assertBrokenAt(again[1], "two rows that swapped places", "prev_hash mismatch")
    }

    @Test
    fun `content outside the hash is refused by the database, and found by the verification if the constraint is gone`() {
        val stray: Map<String, String> = linkedMapOf(
            "after" to """after = '{"role":"WORKER"}'::jsonb""",
            "before" to """"before" = '{"role":"WORKER"}'::jsonb""",
            "ip" to "ip = '203.0.113.7'",
            "user_agent" to "user_agent = 'Mozilla'",
        )
        for ((column, assignment) in stray) {
            clearTables()
            val ids = threeRows()
            val refused = assertThrows<DataAccessException> { tamper("update audit_log set $assignment where id = ${ids[1]}") }
            assertTrue(refused.message!!.contains("audit_log_hash_version_shape"), "$column: ${refused.message}")
            assertTrue(AuditService.verifyChain(dsl).ok, "$column: the refused write left the row alone")

            dsl.withoutRowShapeCheck {
                tamper("update audit_log set $assignment where id = ${ids[1]}")
                assertBrokenAt(ids[1], "$column filled in a version 2 row", "outside its hash")
            }
        }
    }

    @Test
    fun `a row of a version this code does not know is reported, not skipped`() {
        val ids = threeRows()
        dsl.withoutRowShapeCheck {
            tamper("update audit_log set hash_version = 3 where id = ${ids[1]}")
            assertBrokenAt(ids[1], "an unknown version", "unknown hash_version 3")
        }
    }

    @Test
    fun `a forged payload that is not what its columns say is found even when the hash is made to fit`() {
        // An attacker who rewrites a row and recomputes its hash (and every one after it) still has to make the columns agree.
        val ids = threeRows()
        withTriggerOff("audit_log_no_update") {
            val row = rows()[1]
            val forged = row.get(AUDIT_LOG.PAYLOAD_TEXT)!!.replace("report.lock", "report.nothing")
            val digest = AuditHash.payloadDigestV2(row.get(AUDIT_LOG.PAYLOAD_SALT)!!, forged)
            val hash = AuditHash.rowHashV2(row.get(AUDIT_LOG.PREV_HASH)!!, row.get(AUDIT_LOG.PROJECT_ID), digest)
            dsl.execute("update audit_log set payload_text = ?, row_hash = ? where id = ?", forged, hash, ids[1])
            dsl.execute("update audit_log set prev_hash = ? where id = ?", hash, ids[2])
            val third = rows()[2]
            val thirdHash = AuditHash.rowHashV2(hash, null, AuditHash.payloadDigestV2(third.get(AUDIT_LOG.PAYLOAD_SALT)!!, third.get(AUDIT_LOG.PAYLOAD_TEXT)!!))
            dsl.execute("update audit_log set row_hash = ? where id = ?", thirdHash, ids[2])
        }
        assertBrokenAt(ids[1], "a rewritten row whose hashes were recomputed", "does not match its payload")
    }

    @Test
    fun `a rewritten tail with every hash recomputed is a valid chain on its own, and the anchor is what shows it`() {
        // The limit of any hash chain (see PROJECT.md, "Audit log"): the anchor, recorded outside the database, is the answer.
        val ids = threeRows()
        val anchor = AuditService.verifyChain(dsl).head!!
        assertEquals(ids[2], anchor.id)

        withTriggerOff("audit_log_no_update") {
            var prev = rows()[0].get(AUDIT_LOG.ROW_HASH)!!
            for (row in rows().drop(1)) {
                val text = row.get(AUDIT_LOG.PAYLOAD_TEXT)!!.replace("\"n\":2", "\"n\":9").replace("BOSS", "WORKER")
                val digest = AuditHash.payloadDigestV2(row.get(AUDIT_LOG.PAYLOAD_SALT)!!, text)
                val hash = AuditHash.rowHashV2(prev, row.get(AUDIT_LOG.PROJECT_ID), digest)
                dsl.execute("update audit_log set payload_text = ?, prev_hash = ?, row_hash = ? where id = ?", text, prev, hash, row.get(AUDIT_LOG.ID))
                prev = hash
            }
        }

        assertTrue(AuditService.verifyChain(dsl).ok, "internally consistent")
        val anchored = AuditService.verifyChain(dsl, anchor = anchor)
        assertFalse(anchored.ok)
        assertEquals(anchor.id, anchored.brokenAtId)
        assertTrue(anchored.reason!!.contains("anchor mismatch"), anchored.reason)
    }

    // --- the two formats in one chain ----------------------------------------------------------------------------------------

    @Test
    fun `a chain of version 1 rows followed by version 2 rows verifies, and an anchor on an old row stays valid`() = runBlocking {
        val user = createTestUser()
        val first = dsl.insertVersion1Row("legacy.a", "1", after = snapshot("""{"n":1}"""))
        val second = dsl.insertVersion1Row("legacy.b", "2", actorId = user.id.toString(), before = snapshot("""{"n":1}"""), after = snapshot("""{"n":2,"s":"č"}"""))
        val anchorOnOldRow = AuditService.verifyChain(dsl).head!!
        assertEquals(second, anchorOnOldRow.id)

        appendTestAuditRow(user, "new.c", "3", after = snapshot("""{"n":3}"""))
        appendTestAuditRow(user, "new.d", "4")
        // And one more of the old kind afterwards: the chain does not care in which order the formats come.
        dsl.insertVersion1Row("legacy.e", "5")
        appendTestAuditRow(user, "new.f", "6")

        val all = rows()
        assertEquals(listOf(1, 1, 2, 2, 1, 2), all.map { it.get(AUDIT_LOG.HASH_VERSION)!!.toInt() })
        assertEquals(all[1].get(AUDIT_LOG.ROW_HASH), all[2].get(AUDIT_LOG.PREV_HASH), "the first row of the new format is chained to the last row of the old")
        assertEquals(genesis, all[0].get(AUDIT_LOG.PREV_HASH))
        val result = AuditService.verifyChain(dsl)
        assertTrue(result.ok, result.reason)
        assertEquals(6L, result.totalRows)
        assertTrue(AuditService.verifyChain(dsl, anchor = anchorOnOldRow).ok, "an anchor recorded before the upgrade keeps working")
        assertEquals(first, all[0].get(AUDIT_LOG.ID))
    }

    @Test
    fun `a version 1 row is still checked by the old rule, snapshot included`() = runBlocking {
        val user = createTestUser()
        val oldId = dsl.insertVersion1Row("legacy.a", "1", after = snapshot("""{"role":"BOSS"}"""))
        appendTestAuditRow(user, "new.b", "2")
        assertTrue(AuditService.verifyChain(dsl).ok)

        tamper("""update audit_log set after = '{"role":"WORKER"}'::jsonb where id = $oldId""")

        assertBrokenAt(oldId, "a changed snapshot of an old row", "row_hash mismatch on id=$oldId")
    }

    @Test
    fun `an old row cannot be made to look like a new one, nor the reverse`() = runBlocking {
        val user = createTestUser()
        val oldId = dsl.insertVersion1Row("legacy.a", "1", after = snapshot("""{"n":1}"""))
        appendTestAuditRow(user, "new.b", "2")
        // Version 1 written as version 2, with a payload and a salt of the attacker's making.
        tamper("""update audit_log set hash_version = 2, payload_text = '{"action":"legacy.a"}', payload_salt = '$otherSalt', after = null where id = $oldId""")
        assertBrokenAt(oldId, "a version 1 row relabelled as version 2")

        clearTables()
        val user2 = createTestUser()
        val oldId2 = dsl.insertVersion1Row("legacy.a", "1", after = snapshot("""{"n":1}"""))
        appendTestAuditRow(user2, "new.b", "2")
        dsl.withoutRowShapeCheck {
            // Version 1 with the columns of version 2 as well: content that the old rule does not cover.
            tamper("update audit_log set payload_text = '{}' where id = $oldId2")
            assertBrokenAt(oldId2, "a version 1 row that carries a version 2 payload", "version 2")
        }
    }

    // --- what the database accepts -------------------------------------------------------------------------------------------

    private fun insertRaw(
        version: Short?,
        projectId: UUID? = null,
        payloadText: String? = null,
        payloadSalt: String? = null,
        before: JSONB? = null,
        ip: String? = null,
    ) {
        val query = dsl.insertInto(AUDIT_LOG)
            .set(AUDIT_LOG.TS, java.time.OffsetDateTime.now())
            .set(AUDIT_LOG.ACTION, "raw")
            .set(AUDIT_LOG.ENTITY_TYPE, "user")
            .set(AUDIT_LOG.ENTITY_ID, "1")
            .set(AUDIT_LOG.PREV_HASH, genesis)
            .set(AUDIT_LOG.ROW_HASH, UUID.randomUUID().toString().replace("-", "").repeat(2))
            .set(AUDIT_LOG.PROJECT_ID, projectId)
            .set(AUDIT_LOG.PAYLOAD_TEXT, payloadText)
            .set(AUDIT_LOG.PAYLOAD_SALT, payloadSalt)
            .set(AUDIT_LOG.BEFORE, before)
            .set(AUDIT_LOG.IP, ip)
        if (version != null) query.set(AUDIT_LOG.HASH_VERSION, version)
        query.execute()
    }

    @Test
    fun `the database only accepts the two shapes of a row`() {
        // The two valid shapes ...
        insertRaw(1, before = JSONB.jsonb("""{"n":1}"""))
        insertRaw(2, projectId = projectA, payloadText = "{}", payloadSalt = otherSalt)
        insertRaw(2, payloadText = "{}", payloadSalt = otherSalt)
        assertEquals(3, dsl.fetchCount(AUDIT_LOG))

        // ... and everything else.
        val refused: Map<String, () -> Unit> = linkedMapOf(
            "no version stated (a writer must say which format it writes)" to { insertRaw(null, payloadText = "{}", payloadSalt = otherSalt) },
            "an unknown version" to { insertRaw(3, payloadText = "{}", payloadSalt = otherSalt) },
            "version 2 without a payload" to { insertRaw(2, payloadSalt = otherSalt) },
            "version 2 without a salt" to { insertRaw(2, payloadText = "{}") },
            "version 2 with a short salt" to { insertRaw(2, payloadText = "{}", payloadSalt = otherSalt.drop(2)) },
            "version 2 with an upper-case salt" to { insertRaw(2, payloadText = "{}", payloadSalt = otherSalt.uppercase()) },
            "version 2 with a salt that is not hex" to { insertRaw(2, payloadText = "{}", payloadSalt = "z".repeat(64)) },
            "version 2 with a before snapshot" to { insertRaw(2, payloadText = "{}", payloadSalt = otherSalt, before = JSONB.jsonb("{}")) },
            "version 2 with an address" to { insertRaw(2, payloadText = "{}", payloadSalt = otherSalt, ip = "203.0.113.7") },
            "version 1 with a project" to { insertRaw(1, projectId = projectA) },
            "version 1 with a payload" to { insertRaw(1, payloadText = "{}") },
            "version 1 with a salt" to { insertRaw(1, payloadSalt = otherSalt) },
        )
        for ((what, insert) in refused) {
            assertThrows<DataAccessException>(what) { insert() }
        }
        assertEquals(3, dsl.fetchCount(AUDIT_LOG), "none of them was stored")
    }

    // --- a project's part of the chain, with the rest as stubs ---------------------------------------------------------------

    /**
     * A row as an export of one project would hand it over: in full (the payload and its salt), or as a stub, which holds what
     * the hash is made of and nothing of what the row says: where it sits in the chain, which project it belongs to, and the
     * salted digest of its payload.
     */
    private class Exported(
        val id: Long,
        val prevHash: String,
        val rowHash: String,
        val projectId: UUID?,
        val digest: String?,
        val payloadText: String?,
        val salt: String?,
    )

    private fun fullOf(r: Record) = Exported(
        r.get(AUDIT_LOG.ID)!!, r.get(AUDIT_LOG.PREV_HASH)!!, r.get(AUDIT_LOG.ROW_HASH)!!, r.get(AUDIT_LOG.PROJECT_ID),
        digest = null, payloadText = r.get(AUDIT_LOG.PAYLOAD_TEXT), salt = r.get(AUDIT_LOG.PAYLOAD_SALT),
    )

    private fun stubOf(r: Record) = Exported(
        r.get(AUDIT_LOG.ID)!!, r.get(AUDIT_LOG.PREV_HASH)!!, r.get(AUDIT_LOG.ROW_HASH)!!, r.get(AUDIT_LOG.PROJECT_ID),
        digest = AuditHash.payloadDigestV2(r.get(AUDIT_LOG.PAYLOAD_SALT)!!, r.get(AUDIT_LOG.PAYLOAD_TEXT)!!), payloadText = null, salt = null,
    )

    /** What the project's rows look like in an export of [target]: its own in full, everybody else's as stubs. */
    private fun exportFor(target: UUID): List<Exported> = rows().map { if (it.get(AUDIT_LOG.PROJECT_ID) == target) fullOf(it) else stubOf(it) }

    /**
     * What a recipient does with an export, from the export alone: every hash recomputed from what it holds, every link checked,
     * and no stub allowed to name the project that the export is about (a row of that project must be given in full). Returns
     * the first problem, or null.
     */
    private fun verifyExport(rows: List<Exported>, target: UUID): String? {
        var expectedPrev = genesis
        for (row in rows) {
            if (row.prevHash != expectedPrev) return "the chain is broken before id=${row.id}"
            if (row.payloadText == null && row.projectId == target) return "id=${row.id} names the project of the export and is a stub"
            val digest = row.digest ?: AuditHash.payloadDigestV2(row.salt!!, row.payloadText!!)
            if (AuditHash.rowHashV2(row.prevHash, row.projectId, digest) != row.rowHash) return "the hash of id=${row.id} does not fit what the export says of it"
            expectedPrev = row.rowHash
        }
        return null
    }

    /** Seven rows: three projects and a user, interleaved, as a company works. */
    private fun interleavedRows(): List<Long> = runBlocking {
        val user = createTestUser()
        val projectC = UUID.fromString("01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d10")
        suspend fun entry(project: UUID, n: Int) = appendTestAuditRow(
            user, "report.update", "r-$n", entityType = "report", after = snapshot("""{"id":"r-$n","projectId":"$project","workDescription":"Tajný zápis č. $n"}"""),
        )
        entry(projectA, 1)
        entry(projectB, 2)
        appendTestAuditRow(user, "user.update", "u1", after = snapshot("""{"role":"BOSS"}"""))
        entry(projectA, 3)
        entry(projectC, 4)
        entry(projectB, 5)
        entry(projectA, 6)
        rows().map { it.get(AUDIT_LOG.ID)!! }
    }

    @Test
    fun `the part of one project, with the other rows as stubs, verifies on its own`() {
        interleavedRows()

        val export = exportFor(projectA)

        assertNull(verifyExport(export, projectA))
        assertEquals(7, export.size, "every row of the chain is in the export, in order")
        assertEquals(
            dsl.fetchCount(AUDIT_LOG, AUDIT_LOG.PROJECT_ID.eq(projectA)),
            export.count { it.payloadText != null },
            "all rows of the project are given in full",
        )
        assertEquals(3, export.count { it.payloadText != null })
        assertTrue(export.filter { it.payloadText == null }.none { it.projectId == projectA })
        assertEquals(rows().last().get(AUDIT_LOG.ROW_HASH), export.last().rowHash, "and the export ends at the head that an anchor names")
        // The other projects verify the same way, each from its own rows.
        assertNull(verifyExport(exportFor(projectB), projectB))
    }

    @Test
    fun `a stub reveals nothing of what its row says`() {
        interleavedRows()
        val secondRow = rows()[1]   // a row of project B
        val stub = stubOf(secondRow)

        // It holds no payload and no salt, and a recipient who guesses the payload exactly right cannot tell: without the salt
        // the digest cannot be recomputed, and the unsalted hash of the true text is not it.
        assertNull(stub.payloadText)
        assertNull(stub.salt)
        val truth = secondRow.get(AUDIT_LOG.PAYLOAD_TEXT)!!
        assertNotEquals(stub.digest, AuditHash.sha256Hex(truth))
        assertNotEquals(stub.digest, AuditHash.payloadDigestV2("0".repeat(64), truth))
        assertFalse(listOf(stub.digest!!, stub.rowHash, stub.prevHash).any { it.contains("Tajný") })
    }

    @Test
    fun `an export that lies about a row is found by the recipient`() {
        interleavedRows()
        val honest = exportFor(projectA)
        val rowsOfTheChain = rows()
        fun replace(index: Int, row: Exported) = honest.toMutableList().also { it[index] = row }

        // 1. A row of project A hidden as a stub of project B: the project is inside the hash, so the hash no longer fits.
        val hiddenAsOther = stubOf(rowsOfTheChain[3]).let { Exported(it.id, it.prevHash, it.rowHash, projectB, it.digest, null, null) }
        assertNotNull(verifyExport(replace(3, hiddenAsOther), projectA))
        // 2. A row of project A hidden as a stub that still names project A: refused by the recipient's own rule.
        assertNotNull(verifyExport(replace(3, stubOf(rowsOfTheChain[3])), projectA))
        // 3. A row of project A hidden as a stub of no project at all.
        val hiddenAsNone = stubOf(rowsOfTheChain[3]).let { Exported(it.id, it.prevHash, it.rowHash, null, it.digest, null, null) }
        assertNotNull(verifyExport(replace(3, hiddenAsNone), projectA))
        // 4. A stub left out, two stubs swapped.
        assertNotNull(verifyExport(honest.filterIndexed { i, _ -> i != 1 }, projectA))
        assertNotNull(verifyExport(honest.toMutableList().also { val x = it[1]; it[1] = it[4]; it[4] = x }, projectA))
        // 5. A row of the project changed in full: a letter of its text.
        val changed = fullOf(rowsOfTheChain[0]).let { Exported(it.id, it.prevHash, it.rowHash, it.projectId, null, it.payloadText!!.replace("Tajný", "Tajny"), it.salt) }
        assertNotNull(verifyExport(replace(0, changed), projectA))
        // 6. A stub with another digest.
        val wrongDigest = stubOf(rowsOfTheChain[1]).let { Exported(it.id, it.prevHash, it.rowHash, it.projectId, "d".repeat(64), null, null) }
        assertNotNull(verifyExport(replace(1, wrongDigest), projectA))
        // And the honest one stays honest.
        assertNull(verifyExport(honest, projectA))
    }
}
