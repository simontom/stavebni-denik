package cz.stavebni.denik.db

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.flywaydb.core.Flyway
import org.jooq.DSLContext
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import javax.sql.DataSource

object DatabaseFactory {
    lateinit var dsl: DSLContext
        private set

    val isInitialized: Boolean
        get() = ::dsl.isInitialized

    fun pool(jdbcUrl: String, user: String, password: String, maxSize: Int = 10): HikariDataSource =
        HikariDataSource(HikariConfig().apply {
            this.jdbcUrl = jdbcUrl
            this.username = user
            this.password = password
            maximumPoolSize = maxSize
            isAutoCommit = true
            transactionIsolation = "TRANSACTION_READ_COMMITTED"
        })

    /**
     * Connects as the application.
     *
     * - [migrate] true: the schema is migrated first, with these same credentials (development, tests, and the simple
     *   one-role setup). False connects without touching the schema (read-only checks, and an application whose role must
     *   not own anything).
     * - [requireCurrent] true: with [migrate] false, refuses to start on a schema that is not up to date, instead of
     *   failing later at the first query that needs a column that is not there.
     */
    fun init(jdbcUrl: String, user: String, password: String, migrate: Boolean = true, requireCurrent: Boolean = false) {
        initFromDataSource(pool(jdbcUrl, user, password), migrate, requireCurrent)
    }

    /** All schema changes live in Flyway migrations (db/migration); nothing is altered at runtime. */
    fun initFromDataSource(ds: DataSource, migrate: Boolean = true, requireCurrent: Boolean = false) {
        if (migrate) migrate(ds) else if (requireCurrent) requireUpToDate(ds)
        dsl = DSL.using(ds, SQLDialect.POSTGRES)
    }

    private fun flyway(ds: DataSource): Flyway =
        Flyway.configure().dataSource(ds).locations("classpath:db/migration").load()

    /** Applies every pending migration; returns how many ran. Needs a role that may create and alter tables. */
    fun migrate(ds: DataSource): Int = flyway(ds).migrate().migrationsExecuted

    /** Fails when a migration of this build has not been applied to the database (read-only: any role that can read the history). */
    fun requireUpToDate(ds: DataSource) {
        val pending = flyway(ds).info().pending()
        check(pending.isEmpty()) {
            "The database schema is out of date: ${pending.size} migration(s) are pending (first: V${pending.first().version}). " +
                "Run the 'migrate' command with the owner role before starting this version."
        }
    }

    private val ROLE_NAME = Regex("[a-z_][a-z0-9_]{0,62}")

    /**
     * Gives the application's role the privileges of `db/grants/app-role.sql`: data access to every table, nothing else.
     * Run by the owner after migrating, every time. Only a plain lower-case role name is accepted.
     */
    fun grantAppRole(ds: DataSource, role: String) {
        require(ROLE_NAME.matches(role)) { "Not a usable role name: '$role' (lower-case letters, digits and underscore)" }
        val template = DatabaseFactory::class.java.getResourceAsStream("/db/grants/app-role.sql")!!.use { it.readBytes().toString(Charsets.UTF_8) }
        val script = template.replace("\${role}", "\"$role\"")
        ds.connection.use { connection ->
            connection.createStatement().use { it.execute(script) }
        }
    }

    fun initDirect(dslContext: DSLContext) {
        dsl = dslContext
    }
}
