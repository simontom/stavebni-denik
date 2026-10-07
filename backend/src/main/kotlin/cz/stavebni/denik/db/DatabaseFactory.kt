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

    fun init(jdbcUrl: String, user: String, password: String) {
        val ds = HikariDataSource(HikariConfig().apply {
            this.jdbcUrl = jdbcUrl
            this.username = user
            this.password = password
            maximumPoolSize = 10
            isAutoCommit = true
            transactionIsolation = "TRANSACTION_READ_COMMITTED"
        })
        initFromDataSource(ds)
    }

    /** All schema changes live in Flyway migrations (db/migration); nothing is altered at runtime. */
    fun initFromDataSource(ds: DataSource) {
        Flyway.configure()
            .dataSource(ds)
            .locations("classpath:db/migration")
            .load()
            .migrate()

        dsl = DSL.using(ds, SQLDialect.POSTGRES)
    }

    fun initDirect(dslContext: DSLContext) {
        dsl = dslContext
    }
}
