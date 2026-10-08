package cz.stavebni.denik

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.*
import cz.stavebni.denik.services.JwtService
import cz.stavebni.denik.services.PasswordService
import cz.stavebni.denik.services.PdfExportService
import cz.stavebni.denik.services.TypstCompiler
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

    /**
     * Integration tests do not need the typst tool: PDF generation runs against this fake, which
     * writes a small valid PDF. A test that wants the real thing sets
     * `PdfExportService.compiler = ProcessTypstCompiler()` itself (see RealTypstPdfTest).
     */
    @BeforeEach
    fun installFakeTypst() {
        PdfExportService.compiler = FakeTypst
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

/** A minimal but valid PDF, used by tests that only care about the HTTP / file handling around a PDF. */
val MINIMAL_PDF: ByteArray = (
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
        "3 0 obj<</Type/Page/MediaBox[0 0 595 842]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f\n" +
        "0000000009 00000 n\n0000000052 00000 n\n0000000102 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n"
    ).toByteArray(Charsets.ISO_8859_1)

/** Stands in for typst in tests that do not exercise the real tool. */
object FakeTypst : TypstCompiler {
    override fun compile(workDir: java.io.File, typstFile: java.io.File, pdfFile: java.io.File) {
        pdfFile.writeBytes(MINIMAL_PDF)
    }
}
