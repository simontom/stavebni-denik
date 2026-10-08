package cz.stavebni.denik.services

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.cli.AdminCli
import cz.stavebni.denik.db.DatabaseFactory
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * The audit commands run unattended (a nightly check): they must not change the database, and "could not check" must
 * be told apart from "the chain is broken".
 */
class AdminCliGuardTest : BaseIntegrationTest() {

    private class Run(val code: Int, val out: List<String>, val err: List<String>)

    private fun guarded(vararg args: String, connect: () -> Unit = {}): Run {
        val out = mutableListOf<String>()
        val err = mutableListOf<String>()
        val code = AdminCli.runGuarded(args.toList(), out::add, err::add, connect)
        return Run(code, out, err)
    }

    @Test
    fun `only the audit commands are read-only`() {
        assertTrue(AdminCli.readsOnly(listOf("audit-head")))
        assertTrue(AdminCli.readsOnly(listOf("audit-verify", "1:abc")))
        assertFalse(AdminCli.readsOnly(listOf("create-admin", "alice", "Alice")))
        assertFalse(AdminCli.readsOnly(listOf("reset-password", "alice")))
        assertFalse(AdminCli.readsOnly(emptyList()))
    }

    @Test
    fun `a database that cannot be reached is exit code 3, not a broken chain and not an intact one`() {
        val run = guarded("audit-verify") { throw IllegalStateException("Connection to db.example:5432 refused\nsecond line that is not shown") }

        assertEquals(3, run.code)
        assertTrue(run.out.isEmpty(), "nothing is reported as verified: ${run.out}")
        assertEquals(1, run.err.size, run.err.toString())
        assertTrue(run.err.single().contains("refused"), run.err.toString())
        assertFalse(run.err.single().contains("second line"), "one line only")
        assertFalse(run.err.single().contains("BROKEN"), "an unreachable database says nothing about the chain")
    }

    @Test
    fun `the command is not run when the connection fails`() {
        // audit-head would have answered 1 (empty log) if it had run.
        val run = guarded("audit-head") { error("no connection") }
        assertEquals(3, run.code)
    }

    @Test
    fun `when the connection works the command decides the exit code`() {
        // Empty log: audit-head refuses (1); a verified empty log is intact (0).
        assertEquals(1, guarded("audit-head").code)
        assertEquals(0, guarded("audit-verify").code)
    }

    @Test
    fun `reading without migrating leaves an empty database empty, and the check says it could not run`() {
        val container = postgres
        dsl.execute("DROP DATABASE IF EXISTS cli_empty")
        dsl.execute("CREATE DATABASE cli_empty")
        val previous = DatabaseFactory.dsl
        val ds = HikariDataSource(HikariConfig().apply {
            jdbcUrl = container.jdbcUrl.replace(container.databaseName, "cli_empty")
            username = container.username
            password = container.password
            maximumPoolSize = 1
        })
        try {
            val run = guarded("audit-verify") { DatabaseFactory.initFromDataSource(ds, migrate = false) }

            assertEquals(3, run.code, run.err.toString())
            val tables = DatabaseFactory.dsl.fetchValue("select count(*) from information_schema.tables where table_schema = 'public'")
            assertEquals(0, (tables as Number).toInt(), "no migration ran: the schema is still empty")
        } finally {
            DatabaseFactory.initDirect(previous)
            ds.close()
            previous.execute("DROP DATABASE IF EXISTS cli_empty")
        }
    }
}
