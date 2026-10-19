package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
import org.jooq.Record
import org.jooq.exception.DataAccessException
import org.jooq.impl.DSL
import org.jooq.impl.DefaultExecuteListenerProvider
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/**
 * `verifyChain`: what it detects, how it reads a long chain, and that a project's part of the chain, with the rest as stubs,
 * verifies on its own.
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

    private fun reportSnapshot(project: UUID, n: Int = 1) = snapshot("""{"id":"r1","projectId":"$project","n":$n}""")

    /** Three rows of the chain: two of project A (an entry and its signature) and one of a user. Returns their ids. */
    private fun threeRows(): List<Long> = runBlocking {
        val user = createTestUser()
        appendTestAuditRow(user, "report.create", "r1", entityType = "report", after = reportSnapshot(projectA))
        appendTestAuditRow(user, "report.lock", "r1", entityType = "report", before = reportSnapshot(projectA), after = reportSnapshot(projectA, 2))
        appendTestAuditRow(user, "user.update", "u1", entityType = "user", before = snapshot("""{"role":"WORKER"}"""), after = snapshot("""{"role":"BOSS"}"""))
        rows().map { it.get(AUDIT_LOG.ID)!! }
    }

    private fun assertBrokenAt(id: Long, what: String, reasonContains: String? = null) {
        val result = AuditService.verifyChain(dsl)
        assertFalse(result.ok, "$what must be detected")
        assertEquals(id, result.brokenAtId, "$what: the first damaged row")
        if (reasonContains != null) assertTrue(result.reason!!.contains(reasonContains), "$what: ${result.reason}")
    }

    // --- any change of a row is detected -------------------------------------------------------------------------------------

    private val otherSalt = "a".repeat(64)

    @Test
    fun `a change of any part of a row is detected at that row`() {
        val changes: Map<String, (Long) -> String> = linkedMapOf(
            "one byte of the payload" to { id -> "update audit_log set payload_text = replace(payload_text, '\"n\":2', '\"n\":3') where id = $id" },
            "a character of the payload's text" to { id -> "update audit_log set payload_text = replace(payload_text, 'report.lock', 'report.lock ') where id = $id" },
            "the salt" to { id -> "update audit_log set payload_salt = '$otherSalt' where id = $id" },
            "the project, to another project" to { id -> "update audit_log set project_id = '$projectB' where id = $id" },
            "the project, removed" to { id -> "update audit_log set project_id = null where id = $id" },
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

    // --- only one version exists ---------------------------------------------------------------------------------------------

    @Test
    fun `a row of any version but 2 is refused by the database, and reported by the verification if it got in anyway`() {
        for (version in listOf(0, 1, 3)) {
            clearTables()
            val ids = threeRows()
            val refused = assertThrows<DataAccessException>("version $version") { tamper("update audit_log set hash_version = $version where id = ${ids[1]}") }
            assertTrue(refused.message!!.contains("audit_log_hash_version_check"), "version $version: ${refused.message}")
            assertTrue(AuditService.verifyChain(dsl).ok, "the refused write left the row alone")

            dsl.withoutConstraint("audit_log_hash_version_check") {
                tamper("update audit_log set hash_version = $version where id = ${ids[1]}")
                assertBrokenAt(ids[1], "a row of version $version", "unknown hash_version $version on id=${ids[1]}")
            }
        }
    }

    // --- the project of a row must be the one its payload says -------------------------------------------------------------------

    @Test
    fun `a row that names another project than its payload says is found, though its hashes are right`() {
        // What somebody with the right to insert (a stolen application password, a bug) can write past the application:
        // a row about project A that says it belongs to B (so it would leak into B's export and be a stub in A's), or to no
        // project at all (so that it would be a stub in every export).
        val labels: Map<String, (UUID) -> Triple<UUID?, String, String>> = linkedMapOf(
            "an entry of project A labelled B" to { _ -> Triple(projectB, "report", "r1") },
            "an entry of project A labelled with no project" to { _ -> Triple(null, "report", "r1") },
            "a row of project A itself labelled B" to { project -> Triple(projectB, "project", project.toString()) },
            "a row of project A itself labelled with no project" to { project -> Triple(null, "project", project.toString()) },
        )
        for ((what, label) in labels) {
            clearTables()
            val ids = threeRows()
            val (named, type, entityId) = label(projectA)
            val snapshot = if (type == "project") snapshot("""{"userId":"u","role":"BOSS"}""") else reportSnapshot(projectA, 9)
            val id = dsl.insertRowNamingProject(named, "$type.update", entityId, type, after = snapshot)
            dsl.insertRowNamingProject(null, "user.after_forged", "u1", "user")
            assertBrokenAt(id, what, "the project of row id=$id does not match its payload")
            assertTrue(ids.all { it < id })
        }

        // A user's row cannot belong to a project either.
        clearTables()
        threeRows()
        val userRow = dsl.insertRowNamingProject(projectA, "user.update", "u9", "user", after = snapshot("""{"role":"BOSS"}"""))
        assertBrokenAt(userRow, "a user's row labelled with a project", "the project of row id=$userRow does not match its payload")
    }

    @Test
    fun `a row whose project cannot be told from its payload is reported, not skipped`() {
        threeRows()
        // An entity type that has no rule, and a row of a project whose snapshot names none.
        val unknownType = dsl.insertRowNamingProject(null, "invoice.create", "i1", "invoice", after = snapshot("""{"projectId":"$projectA"}"""))
        assertBrokenAt(unknownType, "an entity type without a rule", "the project of row id=$unknownType cannot be told from its payload")

        clearTables()
        threeRows()
        val noProjectInSnapshot = dsl.insertRowNamingProject(projectA, "report.update", "r1", "report", after = snapshot("""{"id":"r1"}"""))
        assertBrokenAt(noProjectInSnapshot, "a snapshot without a project", "cannot be told from its payload")
    }

    @Test
    fun `the message about a mislabelled row holds nothing of the row`() {
        val secret = "Tajný zápis"
        val id = dsl.insertRowNamingProject(
            projectB, "report.update", "r-secret", "report", after = snapshot("""{"projectId":"$projectA","text":"$secret"}"""),
        )
        val reason = AuditService.verifyChain(dsl).reason!!
        assertTrue(reason.contains("id=$id"))
        assertFalse(reason.contains(secret) || reason.contains("r-secret") || reason.contains(projectA.toString()) || reason.contains(projectB.toString()), reason)
    }

    // --- the action belongs to the entity type --------------------------------------------------------------------------------

    @Test
    fun `a row whose action does not belong to its entity type is found, so a row of a project cannot pass as a row of a user`() {
        // The writer chooses the entity type, and a user's row belongs to no project: a row about project A, called a user's,
        // would be a stub in every export and hide A's row from A's. Every action starts with its entity type.
        for (action in listOf("report.update", "project.member.add", "photo.upload", "siteHandover.sign", "authorizedPerson.revoke")) {
            clearTables()
            threeRows()
            val id = dsl.insertRowNamingProject(null, action, "r1", "user", after = reportSnapshot(projectA, 9))
            assertBrokenAt(id, "the action $action on a row of a user", "the action of row id=$id does not belong to its entity type")
        }
        // The other way round, a user's action on a row of a project.
        clearTables()
        threeRows()
        val id = dsl.insertRowNamingProject(projectA, "user.update", "r1", "report", after = reportSnapshot(projectA, 9))
        assertBrokenAt(id, "a user's action on an entry", "does not belong to its entity type")
    }

    // --- a payload cannot be made to crash the verification ---------------------------------------------------------------------

    private fun payloadNestedDeep(levels: Int, ts: java.time.OffsetDateTime): String =
        """{"action":"user.update","actorId":null,"after":null,"before":${"[".repeat(levels)}${"]".repeat(levels)},"entityId":"u1","entityType":"user","ts":"${AuditHash.formatTs(ts)}"}"""

    private fun insertDeepRow(levels: Int): Long {
        val ts = java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).truncatedTo(java.time.temporal.ChronoUnit.MILLIS)
        return dsl.insertRowWithPayload(payloadNestedDeep(levels, ts), ts, null, "user.update", "u1", "user")
    }

    @Test
    fun `a payload nested hundreds of thousands of levels deep is a failed verification with its row, not a crash`() {
        // The 256 KiB limit is the limit of a request; the application's role can insert a row of any size. Parsing such a text
        // recursively would end in a StackOverflowError, which is not an Exception and no command line catches.
        threeRows()
        val id = insertDeepRow(200_000)

        val result = AuditService.verifyChain(dsl)

        assertFalse(result.ok)
        assertEquals(id, result.brokenAtId)
        assertTrue(result.reason!!.contains("the payload of row id=$id is nested too deeply"), result.reason)
    }

    @Test
    fun `the limit of the nesting is the one the writer keeps, 64 containers with the payload itself the first`() {
        threeRows()
        insertDeepRow(AuditHash.MAX_JSON_DEPTH - 1)   // the object of the payload and 63 arrays: 64 levels
        assertTrue(AuditService.verifyChain(dsl).ok, "the deepest payload the writer would write verifies")

        val tooDeep = insertDeepRow(AuditHash.MAX_JSON_DEPTH)
        assertBrokenAt(tooDeep, "one level more", "nested too deeply")
    }

    private class Run(val code: Int, val out: List<String>, val err: List<String>)

    private fun cli(vararg args: String): Run {
        val out = mutableListOf<String>()
        val err = mutableListOf<String>()
        return Run(cz.stavebni.denik.cli.AdminCli.run(args.toList(), out::add, err::add), out, err)
    }

    @Test
    fun `the command line answers 1 and names the row for a hostile payload, it does not die`() {
        threeRows()
        val before = cli("audit-head")
        assertEquals(0, before.code, before.err.toString())
        val id = insertDeepRow(200_000)

        for (command in listOf(arrayOf("audit-verify"), arrayOf("audit-verify", before.out.single()), arrayOf("audit-head"))) {
            val run = cli(*command)
            assertEquals(1, run.code, "${command.toList()}: ${run.err}")
            assertTrue(run.err.single().startsWith("Audit log BROKEN:") && run.err.single().contains("id=$id"), run.err.toString())
            assertTrue(run.out.none { it.contains("OK") }, run.out.toString())
        }
    }

    // --- a forged tail ----------------------------------------------------------------------------------------------------

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

    // --- a long chain is read in bounded pieces -----------------------------------------------------------------------------------

    /** Counts the statements that a block runs. */
    private fun statementsRun(block: (org.jooq.DSLContext) -> Unit): Int {
        var count = 0
        val listener = object : ExecuteListener {
            override fun executeStart(ctx: ExecuteContext) { count++ }
        }
        block(DSL.using(dsl.configuration().derive(DefaultExecuteListenerProvider(listener))))
        return count
    }

    @Test
    fun `the chain is read in pieces bounded by their size in bytes, and verifies the same`() {
        runBlocking {
            val user = createTestUser()
            repeat(8) { n -> appendTestAuditRow(user, "step", "$n", after = snapshot("""{"n":$n,"text":"${"x".repeat(2000)}"}""")) }
        }
        val anchor = AuditService.verifyChain(dsl).head!!

        val whole = statementsRun { AuditService.verifyChain(it, anchor = anchor).also { r -> assertTrue(r.ok, r.reason) } }
        val small = statementsRun { AuditService.verifyChain(it, anchor = anchor, maxBatchBytes = 1).also { r -> assertTrue(r.ok, r.reason); assertEquals(8L, r.totalRows) } }
        val bounded = statementsRun { AuditService.verifyChain(it, maxBatchBytes = 5_000).also { r -> assertTrue(r.ok, r.reason) } }

        assertTrue(small > whole, "one row at a time takes more reads ($small) than everything at once ($whole)")
        assertTrue(bounded in (whole + 1) until small, "a few rows at a time is in between: $bounded")
        // And damage is found whatever the pieces are.
        val fourth = dsl.select(AUDIT_LOG.ID).from(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).offset(3).limit(1).fetchOne()!!.value1()!!
        tamper("update audit_log set entity_id = 'tampered' where id = $fourth")
        for (bytes in listOf(1L, 5_000L, 10_000_000L)) {
            val result = AuditService.verifyChain(dsl, maxBatchBytes = bytes)
            assertFalse(result.ok)
            assertEquals(fourth, result.brokenAtId)
        }
    }

    // --- what the database accepts -------------------------------------------------------------------------------------------

    private fun insertRaw(version: Short?, payloadText: String? = "{}", payloadSalt: String? = otherSalt, projectId: UUID? = null) {
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
        if (version != null) query.set(AUDIT_LOG.HASH_VERSION, version)
        query.execute()
    }

    @Test
    fun `the database only accepts the one shape of a row`() {
        // The valid shape, with a project and without ...
        insertRaw(2, projectId = projectA)
        insertRaw(2)
        assertEquals(2, dsl.fetchCount(AUDIT_LOG))

        // ... and everything else.
        val refused: Map<String, () -> Unit> = linkedMapOf(
            "no version stated (a writer must say which format it writes)" to { insertRaw(null) },
            "version 1, which no longer exists" to { insertRaw(1) },
            "an unknown version" to { insertRaw(3) },
            "no payload" to { insertRaw(2, payloadText = null) },
            "no salt" to { insertRaw(2, payloadSalt = null) },
            "a short salt" to { insertRaw(2, payloadSalt = otherSalt.drop(2)) },
            "an upper-case salt" to { insertRaw(2, payloadSalt = otherSalt.uppercase()) },
            "a salt that is not hex" to { insertRaw(2, payloadSalt = "z".repeat(64)) },
        )
        for ((what, insert) in refused) {
            assertThrows<DataAccessException>(what) { insert() }
        }
        assertEquals(2, dsl.fetchCount(AUDIT_LOG), "none of them was stored")
    }

    @Test
    fun `a row has no column in which content could sit outside its hash`() {
        val columns = dsl.fetch("select column_name from information_schema.columns where table_name = 'audit_log' order by ordinal_position").map { it.get(0) as String }
        assertEquals(
            listOf(
                "id", "ts", "actor_id", "action", "entity_type", "entity_id", "prev_hash", "row_hash",
                "hash_version", "project_id", "payload_text", "payload_salt",
            ),
            columns,
            "the old before, after, ip and user_agent columns are gone: every readable column is the payload, or repeats it and is checked against it",
        )
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
