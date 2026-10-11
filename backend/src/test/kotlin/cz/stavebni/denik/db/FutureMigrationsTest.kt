package cz.stavebni.denik.db

import cz.stavebni.denik.BaseIntegrationTest
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/** A database that belongs to a newer version of the application is recognised, so that `migrate` and a restore can say so. */
class FutureMigrationsTest : BaseIntegrationTest() {

    @Test
    fun `a database of this version has no future migrations, one of a newer version names them`() {
        val scratch = "future_" + System.nanoTime()
        dsl.execute("""create database "$scratch"""")
        val pool = DatabaseFactory.pool(postgres.jdbcUrl.replace(postgres.databaseName, scratch), postgres.username, postgres.password, maxSize = 2)
        try {
            DatabaseFactory.migrate(pool)
            assertEquals(emptyList<String>(), DatabaseFactory.futureMigrations(pool))

            // What a newer version of the application would have left in the history.
            DSL.using(pool, SQLDialect.POSTGRES).execute(
                """insert into flyway_schema_history (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success)
                   values (9999, '999', 'newer version', 'SQL', 'V999__newer_version.sql', 0, 'someone', 0, true)"""
            )

            assertEquals(listOf("V999"), DatabaseFactory.futureMigrations(pool))
        } finally {
            pool.close()
            dsl.execute("""drop database "$scratch" with (force)""")
        }
    }
}
