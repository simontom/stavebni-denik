package cz.stavebni.denik

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.*
import cz.stavebni.denik.services.JwtService
import cz.stavebni.denik.services.PasswordService
import org.jooq.DSLContext
import org.junit.jupiter.api.BeforeEach
import org.testcontainers.containers.PostgreSQLContainer
import java.time.Instant
import java.time.OffsetDateTime
import java.time.temporal.ChronoUnit
import java.util.UUID

abstract class BaseIntegrationTest {

    companion object {
        init {
            System.setProperty("docker.api.version", "1.44")
        }

        val postgres: PostgreSQLContainer<*> by lazy {
            System.setProperty("docker.api.version", "1.44")
            // Credentials are Testcontainers' throwaway defaults.
            val container = PostgreSQLContainer("postgres:18-alpine").apply {
                withDatabaseName("stavebni_denik_test")
                start()
            }

            System.setProperty("JDBC_URL", container.jdbcUrl)
            System.setProperty("DB_USER", container.username)
            System.setProperty("DB_PASSWORD", container.password)

            if (!DatabaseFactory.isInitialized) {
                DatabaseFactory.init(
                    jdbcUrl = container.jdbcUrl,
                    user = container.username,
                    password = container.password
                )
            }
            container
        }
    }

    val dsl: DSLContext get() {
        postgres // ensure container initialized
        return DatabaseFactory.dsl
    }

    @BeforeEach
    open fun cleanDatabase() {
        postgres // ensure container initialized
        clearTables()
    }

    fun clearTables() {
        val tables = listOf(
            "addenda", "audit_log", "authorized_persons", "photos",
            "material_needs", "remarks", "visits", "daily_reports",
            "site_handovers", "project_members", "projects", "sessions",
            "rate_limit_attempts", "notifications", "users"
        )
        DatabaseFactory.dsl.execute("TRUNCATE TABLE " + tables.joinToString(", ") { "\"$it\"" } + " RESTART IDENTITY CASCADE")
    }

    fun createTestUser(
        nickname: String = "user_${UUID.randomUUID().toString().substring(0, 8)}",
        displayName: String = "Test User",
        role: Role = Role.BOSS,
        isAdmin: Boolean = false,
        rawPassword: String = "Password123!"
    ): SessionUser {
        val userId = UUID.randomUUID()
        val pwdHash = PasswordService.hash(rawPassword)
        val now = OffsetDateTime.now()

        dsl.insertInto(USERS)
            .set(USERS.ID, userId)
            .set(USERS.NICKNAME, nickname)
            .set(USERS.DISPLAYNAME, displayName)
            .set(USERS.PASSWORDHASH, pwdHash)
            .set(USERS.ROLE, cz.stavebni.denik.jooq.enums.Role.valueOf(role.name))
            .set(USERS.ISADMIN, isAdmin)
            .set(USERS.ISACTIVE, true)
            .set(USERS.MUSTCHANGEPWD, false)
            .set(USERS.CREATEDAT, now)
            .set(USERS.UPDATEDAT, now)
            .execute()

        return SessionUser(
            id = userId,
            nickname = nickname,
            displayName = displayName,
            role = role,
            isAdmin = isAdmin,
            mustChangePwd = false,
            sessionId = UUID.randomUUID()
        )
    }

    /**
     * A token for [user], backed by a real session row (the server looks the session up on every
     * request). Calling it again for the same [SessionUser] reuses that session.
     */
    fun generateJwtToken(user: SessionUser): String {
        val expiresAt = OffsetDateTime.now().plusHours(12)
        dsl.insertInto(SESSIONS)
            .set(SESSIONS.ID, user.sessionId)
            .set(SESSIONS.USERID, user.id)
            .set(SESSIONS.EXPIRESAT, expiresAt)
            .onConflictDoNothing()
            .execute()
        return JwtService.createToken(user, expiresAt.toInstant())
    }
}
