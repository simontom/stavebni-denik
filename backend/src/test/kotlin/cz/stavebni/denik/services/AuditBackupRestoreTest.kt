package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.db.DatabaseFactory
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * A backup of a database whose audit chain holds rows of both formats (version 1: written by an older version of the
 * application, here built by hand; version 2: every new row), made the way `backup.sh` makes it (`pg_dump`, custom format, no
 * owners) and restored into an empty database the way `restore.sh` does, verifies the same, and so does every anchor recorded
 * before the backup was made.
 */
class AuditBackupRestoreTest : BaseIntegrationTest() {

    @Test
    fun `a backup of a chain of both versions restores and verifies, anchors included`() {
        val scratch = "audit_backup_" + System.nanoTime()
        val restored = "audit_restored_" + System.nanoTime()
        dsl.execute("""create database "$scratch"""")
        val pool = DatabaseFactory.pool(postgres.jdbcUrl.replace(postgres.databaseName, scratch), postgres.username, postgres.password, maxSize = 2)
        val previous = DatabaseFactory.dsl
        try {
            DatabaseFactory.migrate(pool)
            val source = DSL.using(pool, SQLDialect.POSTGRES)

            // Two rows of the old format, then the application's own rows: the chain goes on from the last old row.
            source.insertVersion1Row("legacy.create", "1", after = Json.parseToJsonElement("""{"role":"WORKER","n":1}"""))
            source.insertVersion1Row("legacy.update", "1", before = Json.parseToJsonElement("""{"role":"WORKER"}"""), after = Json.parseToJsonElement("""{"role":"BOSS","note":"č"}"""))
            val anchorOnOldRow = AuditService.verifyChain(source).head!!
            DatabaseFactory.initDirect(source)
            runBlocking {
                appendTestAuditRow(null, "user.new", "2", after = Json.parseToJsonElement("""{"role":"BOSS","quantity":12.0,"tiny":1e-7}"""))
                appendTestAuditRow(null, "user.newer", "3")
            }
            val anchorOnNewRow = AuditService.verifyChain(source).head!!
            assertEquals(listOf(1, 1, 2, 2), source.fetch("select hash_version from audit_log order by id").map { (it.get(0) as Number).toInt() })
            assertEquals(anchorOnOldRow.rowHash, source.fetchValue("select prev_hash from audit_log where id = 3"), "chained across the two formats")

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
                assertEquals(listOf(1, 1, 2, 2), afterRestore.fetch("select hash_version from audit_log order by id").map { (it.get(0) as Number).toInt() })
                assertEquals(
                    source.fetch("select id, row_hash, prev_hash, payload_text, payload_salt from audit_log order by id").intoMaps(),
                    afterRestore.fetch("select id, row_hash, prev_hash, payload_text, payload_salt from audit_log order by id").intoMaps(),
                    "the restored rows are the rows of the backup, to the byte",
                )
                for (anchor in listOf(anchorOnOldRow, anchorOnNewRow)) {
                    val result = AuditService.verifyChain(afterRestore, anchor = anchor)
                    assertTrue(result.ok, result.reason)
                    assertEquals(4L, result.totalRows)
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
