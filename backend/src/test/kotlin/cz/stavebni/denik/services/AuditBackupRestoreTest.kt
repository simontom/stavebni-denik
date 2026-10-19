package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.db.DatabaseFactory
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/**
 * A backup of a database with an audit chain, made the way `backup.sh` makes it (`pg_dump`, custom format, no owners) and
 * restored into an empty database the way `restore.sh` does, holds the same rows to the byte, verifies, and so does every
 * anchor recorded before the backup was made: the text of a payload and its salt come back exactly as they went in.
 */
class AuditBackupRestoreTest : BaseIntegrationTest() {

    @Test
    fun `a backup of a chain restores to the same rows and verifies, anchors included`() {
        val scratch = "audit_backup_" + System.nanoTime()
        val restored = "audit_restored_" + System.nanoTime()
        dsl.execute("""create database "$scratch"""")
        val pool = DatabaseFactory.pool(postgres.jdbcUrl.replace(postgres.databaseName, scratch), postgres.username, postgres.password, maxSize = 2)
        val previous = DatabaseFactory.dsl
        try {
            DatabaseFactory.migrate(pool)
            val source = DSL.using(pool, SQLDialect.POSTGRES)
            DatabaseFactory.initDirect(source)

            val project = UUID.randomUUID()
            runBlocking {
                appendTestAuditRow(null, "user.new", "1", after = Json.parseToJsonElement("""{"role":"BOSS","quantity":12.0,"tiny":1e-7,"text":"č ž \u0000 \\ \" 😀"}"""))
                appendTestAuditRow(null, "report.update", "r1", entityType = "report", after = Json.parseToJsonElement("""{"projectId":"$project","n":1}"""))
            }
            val anchorOnTheMiddle = AuditService.verifyChain(source).head!!
            runBlocking { appendTestAuditRow(null, "user.newer", "2") }
            val anchorOnTheHead = AuditService.verifyChain(source).head!!

            fun exec(vararg command: String) {
                val outcome = postgres.execInContainer(*command)
                assertEquals(0, outcome.exitCode, "${command.joinToString(" ")}: ${outcome.stderr}")
            }
            val dump = "/tmp/$scratch.dump"
            exec("pg_dump", "-U", postgres.username, "-d", scratch, "--format=custom", "--no-owner", "--no-acl", "--file", dump)
            dsl.execute("""create database "$restored"""")
            exec("pg_restore", "-U", postgres.username, "-d", restored, "--no-owner", "--no-acl", "--exit-on-error", dump)

            DatabaseFactory.pool(postgres.jdbcUrl.replace(postgres.databaseName, restored), postgres.username, postgres.password, maxSize = 2).use { restoredPool ->
                val afterRestore = DSL.using(restoredPool, SQLDialect.POSTGRES)
                val columns = "id, ts, actor_id, action, entity_type, entity_id, prev_hash, row_hash, hash_version, project_id, payload_text, payload_salt"
                assertEquals(
                    source.fetch("select $columns from audit_log order by id").intoMaps(),
                    afterRestore.fetch("select $columns from audit_log order by id").intoMaps(),
                    "the restored rows are the rows of the backup, to the byte",
                )
                for (anchor in listOf(anchorOnTheMiddle, anchorOnTheHead)) {
                    val result = AuditService.verifyChain(afterRestore, anchor = anchor)
                    assertTrue(result.ok, result.reason)
                    assertEquals(3L, result.totalRows)
                }
            }
        } finally {
            DatabaseFactory.initDirect(previous)
            pool.close()
            dsl.execute("""drop database "$scratch" with (force)""")
            dsl.execute("""drop database if exists "$restored" with (force)""")
        }
    }
}
