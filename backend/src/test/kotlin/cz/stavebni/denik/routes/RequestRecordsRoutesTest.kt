package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.cli.AdminCli
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.ACCESS_LOG
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.AUDIT_REQUEST_CONTEXT
import cz.stavebni.denik.module
import cz.stavebni.denik.services.AccessLogService
import cz.stavebni.denik.services.AuditService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.coroutines.runBlocking
import org.jooq.exception.DataAccessException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.OffsetDateTime

/**
 * Decision D7: the address and user agent of a request are personal data. They stay out of the audit hash and live in side
 * tables that are kept for twelve months (migration V12), next to a log of sign-ins that is not part of the legal chain.
 */
class RequestRecordsRoutesTest : BaseIntegrationTest() {

    private fun projectBody(managerId: String) =
        ProjectDto(
            id = "", name = "Kontext", address = "A 1", cadastralArea = "C", parcelNumbers = "1",
            builder = "B", contractor = "C", siteManagerId = managerId,
        )

    private fun accessEvents(): List<String> =
        dsl.select(ACCESS_LOG.EVENT).from(ACCESS_LOG).orderBy(ACCESS_LOG.ID.asc()).fetch(ACCESS_LOG.EVENT).filterNotNull()

    // --- where a request came from ---------------------------------------------------------------------------------

    @Test
    fun `a change made through a request records the address and user agent outside the audit hash`() = testApplication {
        application { module() }
        val client = createClient { install(ContentNegotiation) { json() } }
        val boss = createTestUser(role = Role.BOSS)

        val response = client.post("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}")
            header(HttpHeaders.UserAgent, "Test-Agent/1.0")
            contentType(ContentType.Application.Json)
            setBody(projectBody(boss.id.toString()))
        }
        assertEquals(HttpStatusCode.OK, response.status)

        val auditId = dsl.select(AUDIT_LOG.ID).from(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("project.create")).fetchSingle(AUDIT_LOG.ID)!!
        val context = dsl.selectFrom(AUDIT_REQUEST_CONTEXT).where(AUDIT_REQUEST_CONTEXT.AUDIT_ID.eq(auditId)).fetchSingle()
        assertEquals("Test-Agent/1.0", context.userAgent)
        assertFalse(context.ip.isNullOrBlank(), "the address of the request is recorded")

        // The audit row itself, and so its hash, carries none of it: the chain can stay while the side row is deleted.
        val row = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ID.eq(auditId)).fetchSingle()
        assertNull(row.ip)
        assertNull(row.userAgent)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `a change made without a request has no side row`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)

        ProjectService.createProject(boss, projectBody(boss.id.toString()))

        assertEquals(1, dsl.fetchCount(AUDIT_LOG))
        assertEquals(0, dsl.fetchCount(AUDIT_REQUEST_CONTEXT))
    }

    @Test
    fun `a user agent an attacker made enormous is cut to a bounded length`() = testApplication {
        application { module() }
        val client = createClient { install(ContentNegotiation) { json() } }
        val boss = createTestUser(role = Role.BOSS)

        client.post("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}")
            header(HttpHeaders.UserAgent, "x".repeat(5000))
            contentType(ContentType.Application.Json)
            setBody(projectBody(boss.id.toString()))
        }

        val stored = dsl.select(AUDIT_REQUEST_CONTEXT.USER_AGENT).from(AUDIT_REQUEST_CONTEXT).fetchSingle(AUDIT_REQUEST_CONTEXT.USER_AGENT)!!
        assertEquals(256, stored.length)
    }

    @Test
    fun `control characters are stripped from the stored user agent`() = testApplication {
        application { module() }
        val client = createClient { install(ContentNegotiation) { json() } }
        val boss = createTestUser(role = Role.BOSS)

        client.post("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(boss)}")
            header(HttpHeaders.UserAgent, "Agent\tWith\tTabs/1")
            contentType(ContentType.Application.Json)
            setBody(projectBody(boss.id.toString()))
        }

        assertEquals("AgentWithTabs/1", dsl.select(AUDIT_REQUEST_CONTEXT.USER_AGENT).from(AUDIT_REQUEST_CONTEXT).fetchSingle(AUDIT_REQUEST_CONTEXT.USER_AGENT))
    }

    // --- the sign-in log -------------------------------------------------------------------------------------------

    @Test
    fun `sign-in, a wrong password and sign-out are recorded with the account`() = testApplication {
        application { module() }
        val client = createClient { install(ContentNegotiation) { json() } }
        val user = createTestUser(nickname = "access_user", rawPassword = "Password123!")

        client.post("/api/auth/login") {
            header(HttpHeaders.UserAgent, "Browser/9")
            contentType(ContentType.Application.Json)
            setBody(LoginRequest("access_user", "wrong password"))
        }
        val signedIn = client.post("/api/auth/login") {
            header(HttpHeaders.UserAgent, "Browser/9")
            contentType(ContentType.Application.Json)
            setBody(LoginRequest("access_user", "Password123!"))
        }
        val token = signedIn.headers[HttpHeaders.SetCookie]!!.substringAfter("jwt=").substringBefore(";")
        client.post("/api/auth/logout") { header(HttpHeaders.Cookie, "jwt=$token") }

        assertEquals(listOf("login.failure", "login.success", "logout"), accessEvents())
        val rows = dsl.selectFrom(ACCESS_LOG).orderBy(ACCESS_LOG.ID.asc()).fetch()
        rows.forEach { assertEquals(user.id, it.userId) }
        assertEquals("Browser/9", rows[0].userAgent)
        assertFalse(rows[0].ip.isNullOrBlank())
    }

    @Test
    fun `a failed attempt against a name that does not exist records no name at all`() = testApplication {
        application { module() }
        val client = createClient { install(ContentNegotiation) { json() } }

        // Someone who typed their password into the name field must not end up in a log that is kept for a year.
        client.post("/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest("Hunter2-my-real-password", "whatever"))
        }

        val row = dsl.selectFrom(ACCESS_LOG).fetchSingle()
        assertEquals("login.failure", row.event)
        assertNull(row.userId)
        assertFalse(row.toString().contains("Hunter2"), "nothing the person typed as a name is stored: $row")
    }

    // --- retention -------------------------------------------------------------------------------------------------

    private fun insertAccessLog(event: String, recordedAt: OffsetDateTime) {
        dsl.execute("""insert into access_log (event, recorded_at) values (?, ?::timestamptz)""", event, recordedAt)
    }

    @Test
    fun `the database refuses to change a record or to delete one younger than twelve months`() {
        insertAccessLog("login.success", OffsetDateTime.now().minusMonths(11))
        insertAccessLog("login.success", OffsetDateTime.now().minusMonths(13))

        assertThrows(DataAccessException::class.java) { dsl.execute("""update access_log set ip = '1.2.3.4'""") }
        val young = dsl.select(ACCESS_LOG.ID).from(ACCESS_LOG).where(ACCESS_LOG.RECORDED_AT.gt(OffsetDateTime.now().minusMonths(12))).fetchSingle(ACCESS_LOG.ID)!!
        assertThrows(DataAccessException::class.java) { dsl.execute("""delete from access_log where id = ?""", young) }

        // Older than twelve months it may go: that is what the retention promise is.
        assertEquals(1, dsl.execute("""delete from access_log where recorded_at < now() - interval '12 months'"""))
        assertEquals(1, dsl.fetchCount(ACCESS_LOG))
    }

    @Test
    fun `the request records of audit rows are guarded the same way`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        ProjectService.createProject(boss, projectBody(boss.id.toString()))
        val auditId = dsl.select(AUDIT_LOG.ID).from(AUDIT_LOG).fetchSingle(AUDIT_LOG.ID)!!
        dsl.execute("""insert into audit_request_context (audit_id, ip, recorded_at) values (?, '1.2.3.4', ?::timestamptz)""", auditId, OffsetDateTime.now().minusMonths(2))

        assertThrows(DataAccessException::class.java) { dsl.execute("""update audit_request_context set ip = '9.9.9.9'""") }
        assertThrows(DataAccessException::class.java) { dsl.execute("""delete from audit_request_context""") }
        assertEquals(1, dsl.fetchCount(AUDIT_REQUEST_CONTEXT))
    }

    @Test
    fun `pruning removes what is older than twelve months from both tables and nothing else`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        ProjectService.createProject(boss, projectBody(boss.id.toString()))
        ProjectService.createProject(boss, projectBody(boss.id.toString()).copy(name = "Druhý"))
        val auditIds = dsl.select(AUDIT_LOG.ID).from(AUDIT_LOG).orderBy(AUDIT_LOG.ID.asc()).fetch(AUDIT_LOG.ID).filterNotNull()
        dsl.execute("""insert into audit_request_context (audit_id, ip, recorded_at) values (?, '1.1.1.1', ?::timestamptz)""", auditIds[0], OffsetDateTime.now().minusMonths(13))
        dsl.execute("""insert into audit_request_context (audit_id, ip, recorded_at) values (?, '2.2.2.2', ?::timestamptz)""", auditIds[1], OffsetDateTime.now().minusMonths(11))
        insertAccessLog("login.success", OffsetDateTime.now().minusMonths(14))
        insertAccessLog("login.failure", OffsetDateTime.now().minusMonths(1))

        val pruned = AccessLogService.prune(dsl)

        assertEquals(1, pruned.accessLog)
        assertEquals(1, pruned.auditRequestContext)
        assertEquals(listOf("login.failure"), accessEvents())
        assertEquals("2.2.2.2", dsl.select(AUDIT_REQUEST_CONTEXT.IP).from(AUDIT_REQUEST_CONTEXT).fetchSingle(AUDIT_REQUEST_CONTEXT.IP))
        assertEquals(2, dsl.fetchCount(AUDIT_LOG), "the audit chain itself is never pruned")
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `the operator command prunes and takes no arguments`() {
        insertAccessLog("login.success", OffsetDateTime.now().minusMonths(20))
        val out = mutableListOf<String>()
        val err = mutableListOf<String>()

        val code = AdminCli.run(listOf("prune-access-records"), out::add, err::add)

        assertEquals(0, code, err.toString())
        assertTrue(out.single().contains("Pruned 1 sign-in log rows"), out.toString())
        assertTrue(AdminCli.hasValidShape(listOf("prune-access-records")))
        assertFalse(AdminCli.hasValidShape(listOf("prune-access-records", "3")))
        assertFalse(AdminCli.readsOnly(listOf("prune-access-records")))
    }
}
