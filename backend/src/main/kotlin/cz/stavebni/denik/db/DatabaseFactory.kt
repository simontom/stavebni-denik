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

    private fun applySchemaDefaults(ds: DataSource) {
        ds.connection.use { conn ->
            conn.createStatement().use { stmt ->
                stmt.execute("""
                    ALTER TABLE IF EXISTS "projects" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
                    ALTER TABLE IF EXISTS "daily_reports" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
                    ALTER TABLE IF EXISTS "site_handovers" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
                    ALTER TABLE IF EXISTS "authorized_persons" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
                    ALTER TABLE IF EXISTS "users" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
                    ALTER TABLE IF EXISTS "material_needs" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
                    ALTER TABLE IF EXISTS "visits" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
                    ALTER TABLE IF EXISTS "project_members" ALTER COLUMN "role" SET DEFAULT 'BOSS';
                """.trimIndent())
            }
        }
    }

    fun init(jdbcUrl: String, user: String, password: String) {
        val ds = HikariDataSource(HikariConfig().apply {
            this.jdbcUrl = jdbcUrl
            this.username = user
            this.password = password
            maximumPoolSize = 10
            isAutoCommit = true
            transactionIsolation = "TRANSACTION_READ_COMMITTED"
        })

        Flyway.configure()
            .dataSource(ds)
            .locations("classpath:db/migration")
            .load()
            .migrate()

        applySchemaDefaults(ds)

        dsl = DSL.using(ds, SQLDialect.POSTGRES)
    }

    fun initFromDataSource(ds: DataSource) {
        Flyway.configure()
            .dataSource(ds)
            .locations("classpath:db/migration")
            .load()
            .migrate()

        applySchemaDefaults(ds)

        dsl = DSL.using(ds, SQLDialect.POSTGRES)
    }

    fun initDirect(dslContext: DSLContext) {
        dsl = dslContext
    }
}
