package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** HTTP behaviour of signing and acknowledging a daily report (status codes and who may do what). */
class ReportSigningRoutesTest : BaseIntegrationTest() {

    private suspend fun createProject(owner: SessionUser, name: String = "Signing Project"): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = name, address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor",
                siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    private suspend fun ApplicationTestBuilder.post(path: String, user: SessionUser): HttpResponse =
        client.post(path) {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            contentType(ContentType.Application.Json)
            // Signing asks for the password again; the other POSTs of this file ignore the field.
            setBody("""{"password":"Password123!"}""")
        }

    private suspend fun ApplicationTestBuilder.get(path: String, user: SessionUser): HttpResponse =
        client.get(path) { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }

    @Test
    fun `signing the same report twice answers 200 and then 409 with a readable message`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29")

        val first = post("/api/projects/$projectId/reports/${report.id}/sign", boss)
        val second = post("/api/projects/$projectId/reports/${report.id}/sign", boss)

        assertEquals(HttpStatusCode.OK, first.status)
        assertEquals(HttpStatusCode.Conflict, second.status)
        assertTrue(second.bodyAsText().contains("již podepsán"), second.bodyAsText())
    }

    @Test
    fun `the report-id route signs by id and refuses a bare date`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29")

        // A date is only unique within a project, so it cannot name a report on this route.
        val byDate = post("/api/reports/2026-09-29/sign", boss)
        assertEquals(HttpStatusCode.BadRequest, byDate.status)

        val byId = post("/api/reports/${report.id}/sign", boss)
        assertEquals(HttpStatusCode.OK, byId.status)
    }

    @Test
    fun `a BOSS of another project gets 403 when signing`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val outsider = createTestUser(role = Role.BOSS)
        val projectId = createProject(boss)
        createProject(outsider, "Somebody else's project")
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29")

        assertEquals(HttpStatusCode.Forbidden, post("/api/reports/${report.id}/sign", outsider).status)
        assertEquals(HttpStatusCode.Forbidden, post("/api/projects/$projectId/reports/${report.id}/sign", outsider).status)
    }

    @Test
    fun `an app admin can read a project's reports but cannot create or sign`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val adminBoss = createTestUser(role = Role.BOSS, isAdmin = true)
        val projectId = createProject(boss)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29")

        assertEquals(HttpStatusCode.OK, get("/api/projects/$projectId/reports", adminBoss).status)
        assertEquals(HttpStatusCode.OK, get("/api/projects/$projectId/reports/${report.id}", adminBoss).status)

        assertEquals(HttpStatusCode.Forbidden, post("/api/projects/$projectId/reports", adminBoss).status)
        assertEquals(HttpStatusCode.Forbidden, post("/api/projects/$projectId/reports/${report.id}/sign", adminBoss).status)
        assertEquals(HttpStatusCode.Forbidden, post("/api/reports/${report.id}/sign", adminBoss).status)
    }

    @Test
    fun `acknowledging answers 409 until the report is signed and after it was acknowledged`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val investor = createTestUser(role = Role.INVESTOR)
        val projectId = createProject(boss)
        addMember(projectId, investor)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29")
        val ack = "/api/projects/$projectId/reports/${report.id}/acknowledge"

        val unsigned = post(ack, investor)
        assertEquals(HttpStatusCode.Conflict, unsigned.status)
        assertTrue(unsigned.bodyAsText().contains("není podepsán"), unsigned.bodyAsText())

        assertEquals(HttpStatusCode.OK, post("/api/projects/$projectId/reports/${report.id}/sign", boss).status)
        assertEquals(HttpStatusCode.OK, post(ack, investor).status)
        assertEquals(HttpStatusCode.Conflict, post(ack, investor).status)
    }

    @Test
    fun `a report id of another project is a 404 through this project's route`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val projectA = createProject(boss, "Project A")
        val projectB = createProject(boss, "Project B")
        val reportOfB = DailyReportService.createReport(boss, projectB, "2026-09-29")

        assertEquals(HttpStatusCode.NotFound, get("/api/projects/$projectA/reports/${reportOfB.id}", boss).status)
        assertEquals(HttpStatusCode.OK, get("/api/projects/$projectB/reports/${reportOfB.id}", boss).status)
    }
}
