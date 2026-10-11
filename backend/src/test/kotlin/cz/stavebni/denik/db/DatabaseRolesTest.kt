package cz.stavebni.denik.db

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.cli.AdminCli
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.services.AuditService
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import kotlinx.coroutines.runBlocking
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/**
 * Separate database roles (decision D5): the application runs under a role that owns nothing, so the triggers and rules the
 * migrations put in bind it (and whoever steals its password): it cannot create or drop a table, switch a trigger off,
 * truncate anything, or touch the audit log.
 */
class DatabaseRolesTest : BaseIntegrationTest() {

    private val role = "denik_app_test"
    private val rolePassword = "role-test-" + UUID.randomUUID().toString().take(8)

    private fun ownerPool(database: String? = null) =
        DatabaseFactory.pool(
            postgres.jdbcUrl.let { url -> if (database == null) url else url.replace(postgres.databaseName, database) },
            postgres.username, postgres.password, maxSize = 2,
        )

    private fun withAppRole(block: (appDsl: org.jooq.DSLContext) -> Unit) {
        val owner = ownerPool()
        runCatching { dsl.execute("DROP ROLE IF EXISTS $role") }
        dsl.execute("CREATE ROLE $role LOGIN PASSWORD '$rolePassword' NOSUPERUSER NOCREATEDB NOCREATEROLE")
        DatabaseFactory.grantAppRole(owner, role)
        val appPool = DatabaseFactory.pool(postgres.jdbcUrl, role, rolePassword, maxSize = 4)
        try {
            block(DSL.using(appPool, SQLDialect.POSTGRES))
        } finally {
            appPool.close()
            owner.close()
            dsl.execute("DROP OWNED BY $role")
            dsl.execute("DROP ROLE $role")
        }
    }

    @Test
    fun `the application's role does its work but cannot change the structure or the guards`() {
        withAppRole { app ->
            // What it needs: data access.
            val id = UUID.randomUUID()
            app.execute(
                """insert into users (id, nickname, "displayName", "passwordHash", role, "isAdmin", "isActive", "mustChangePwd", "updatedAt")
                   values (?, 'role_user', 'Role User', 'x', 'WORKER', false, true, false, now())""", id,
            )
            assertEquals(1, app.fetchCount(org.jooq.impl.DSL.table(org.jooq.impl.DSL.name("users")), org.jooq.impl.DSL.field(org.jooq.impl.DSL.name("id")).eq(id)))
            app.execute("""update users set "displayName" = 'Changed' where id = ?""", id)
            app.execute("delete from users where id = ?", id)
            assertTrue(app.fetchValue("select count(*) from flyway_schema_history") as Long > 0, "it can read the schema history")

            // What it must not do: all of these are refused by the database.
            val forbidden = listOf(
                "create table intruder (x int)",
                "drop table users",
                "alter table users add column z int",
                "alter table audit_log disable trigger all",
                "alter table audit_log disable trigger audit_log_no_update",
                "alter table daily_reports disable trigger daily_reports_locked_immutable",
                "alter table addenda disable trigger addenda_append_only",
                "drop trigger audit_log_no_update on audit_log",
                "create trigger t before insert on users for each row execute function addenda_append_only()",
                "create or replace function addenda_append_only() returns trigger language plpgsql as 'begin return new; end'",
                "truncate users",
                "truncate audit_log",
                "delete from audit_log",
                "update audit_log set action = 'x'",
                "insert into flyway_schema_history (installed_rank, description, type, script, checksum, installed_by, execution_time, success) values (999, 'x', 'SQL', 'x', 0, 'x', 0, true)",
                "delete from flyway_schema_history",
                "alter role $role superuser",
                "create role other_role",
            )
            for (statement in forbidden) {
                assertTrue(runCatching { app.execute(statement) }.isFailure, "the application's role must not be able to: $statement")
            }
            assertTrue(dsl.fetchValue("select count(*) from audit_log") as Long >= 0)
        }
    }

    @Test
    fun `the whole application works under the unprivileged role, and the audit chain verifies`() {
        withAppRole { app ->
            val previous = DatabaseFactory.dsl
            DatabaseFactory.initDirect(app)
            try {
                runBlocking {
                    val boss = createTestUser(nickname = "boss", role = Role.BOSS)
                    val project = ProjectService.createProject(
                        boss,
                        ProjectDto(
                            id = "", name = "Roles", address = "A", cadastralArea = "C", parcelNumbers = "1",
                            builder = "B", contractor = "C", siteManagerId = boss.id.toString(),
                        ),
                    )
                    val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28", workDescription = "Betonáž")
                    DailyReportService.signReport(boss, UUID.fromString(report.id))
                    assertTrue(AuditService.verifyChain(app).ok, "the chain written by the unprivileged role verifies")
                    // The guards still bind it: the signed report cannot be changed, not even by this role.
                    assertTrue(runCatching { app.execute("""update daily_reports set "workDescription" = 'x' where id = ?""", UUID.fromString(report.id)) }.isFailure)
                }
            } finally {
                DatabaseFactory.initDirect(previous)
            }
        }
    }

    @Test
    fun `a table that a later migration creates is covered too`() {
        withAppRole { app ->
            dsl.execute("create table later_table (id int primary key, note text)")
            try {
                app.execute("insert into later_table (id, note) values (1, 'a')")
                app.execute("update later_table set note = 'b' where id = 1")
                assertTrue(runCatching { app.execute("truncate later_table") }.isFailure, "but still no truncate")
            } finally {
                dsl.execute("drop table later_table")
            }
        }
    }

    @Test
    fun `migrate brings an empty database up to date, and a schema that is not current is refused`() {
        val database = "mig_" + UUID.randomUUID().toString().replace("-", "").take(10)
        dsl.execute("create database $database")
        try {
            ownerPool(database).use { ds ->
                val pending = assertThrows<IllegalStateException> { DatabaseFactory.requireUpToDate(ds) }
                assertTrue(pending.message!!.contains("migrate"), pending.message)

                val total = org.flywaydb.core.Flyway.configure().dataSource(ds).locations("classpath:db/migration").load().info().all().size
                val applied = DatabaseFactory.migrate(ds)
                assertEquals(total, applied, "every migration of this build ran")
                assertTrue(applied >= 10, "applied $applied")
                DatabaseFactory.requireUpToDate(ds) // now it is current
                assertEquals(0, DatabaseFactory.migrate(ds), "a second run changes nothing")
            }
        } finally {
            dsl.execute("drop database $database with (force)")
        }
    }

    @Test
    fun `only a plain role name is accepted`() {
        ownerPool().use { ds ->
            for (bad in listOf("", "App", "app\"; drop table users; --", "a b", "9app", "x".repeat(64))) {
                assertThrows<IllegalArgumentException>(bad) { DatabaseFactory.grantAppRole(ds, bad) }
            }
        }
    }

    @Test
    fun `the migrate command takes no arguments`() {
        assertTrue(AdminCli.hasValidShape(listOf("migrate")))
        assertFalse(AdminCli.hasValidShape(listOf("migrate", "extra")))
        assertFalse(AdminCli.readsOnly(listOf("migrate")))
    }
}
