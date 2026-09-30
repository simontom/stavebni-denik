package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.module
import cz.stavebni.denik.services.AddMemberRequest
import cz.stavebni.denik.services.AuthorizedPersonDto
import cz.stavebni.denik.services.CreateAuthorizedPersonRequest
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectMemberDto
import cz.stavebni.denik.services.SiteHandoverDto
import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class ProjectDetailRoutesTest : BaseIntegrationTest() {

    private fun ApplicationTestBuilder.jsonClient() = createClient {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
    }

    @Test
    fun `project detail, members, authorized persons and handovers round-trip`() = testApplication {
        application { module() }
        val client = jsonClient()
        val boss = createTestUser(role = Role.BOSS)
        val investor = createTestUser(role = Role.INVESTOR)
        val outsider = createTestUser(role = Role.BOSS)
        val token = generateJwtToken(boss)

        // create project with legislative fields
        val project = client.post("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(
                ProjectDto(
                    name = "Detail", address = "A", cadastralArea = "K", parcelNumbers = "1",
                    builder = "B", contractor = "C", siteManagerId = boss.id.toString(),
                    contractNumber = "SML-123", contractDate = "2026-09-01",
                    designDocVersion = "v1.2", designDocDate = "2026-08-15",
                )
            )
        }.body<ProjectDto>()

        // detail keeps legislative fields
        val detail = client.get("/api/projects/${project.id}") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.OK, detail.status)
        val dto = detail.body<ProjectDto>()
        assertEquals("SML-123", dto.contractNumber)
        assertEquals("2026-09-01", dto.contractDate)
        assertEquals("v1.2", dto.designDocVersion)
        assertEquals("2026-08-15", dto.designDocDate)

        // outsiders cannot open it
        val forbidden = client.get("/api/projects/${project.id}") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(outsider)}")
        }
        assertEquals(HttpStatusCode.Forbidden, forbidden.status)
        val forbiddenReports = client.get("/api/projects/${project.id}/reports") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(outsider)}")
        }
        assertEquals(HttpStatusCode.Forbidden, forbiddenReports.status)

        // members: add investor
        val members = client.post("/api/projects/${project.id}/members") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(AddMemberRequest(userId = investor.id.toString(), role = "INVESTOR"))
        }.body<List<ProjectMemberDto>>()
        assertTrue(members.any { it.userId == investor.id.toString() && it.role == "INVESTOR" })
        assertTrue(members.any { it.userId == boss.id.toString() })

        // investor can now open the project
        val asInvestor = client.get("/api/projects/${project.id}") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(investor)}")
        }
        assertEquals(HttpStatusCode.OK, asInvestor.status)

        // authorized persons: create + revoke
        val person = client.post("/api/projects/${project.id}/authorized-persons") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(CreateAuthorizedPersonRequest(name = "Ing. Arch. Petr Černý", company = "Architekti s.r.o.", authorization = "Autorský dozor"))
        }
        assertEquals(HttpStatusCode.Created, person.status)
        val personDto = person.body<AuthorizedPersonDto>()
        assertNull(personDto.revokedAt)
        val revoked = client.post("/api/authorized-persons/${personDto.id}/revoke") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }.body<AuthorizedPersonDto>()
        assertNotNull(revoked.revokedAt)

        // handovers: create with a plain date + sign
        val handover = client.post("/api/projects/${project.id}/handovers") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(
                SiteHandoverDto(
                    projectId = project.id, type = "Předání staveniště zhotoviteli", date = "2026-09-11",
                    participants = "Novák, Svoboda",
                    meterStates = listOf(MeterState("Elektřina VT", "EL-98765", "12450 kWh")),
                )
            )
        }
        assertEquals(HttpStatusCode.Created, handover.status)
        val handoverDto = handover.body<SiteHandoverDto>()
        assertEquals("2026-09-11", handoverDto.date)
        assertEquals("12450 kWh", handoverDto.meterStates?.single()?.state)

        val signed = client.post("/api/handovers/${handoverDto.id}/sign") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }.body<SiteHandoverDto>()
        assertNotNull(signed.signedAt)

        val list = client.get("/api/projects/${project.id}/handovers") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }.body<List<SiteHandoverDto>>()
        assertEquals(1, list.size)
    }

    @Test
    fun `unknown project returns 404`() = testApplication {
        application { module() }
        val client = jsonClient()
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val resp = client.get("/api/projects/00000000-0000-0000-0000-000000000000") {
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(admin)}")
        }
        assertEquals(HttpStatusCode.NotFound, resp.status)
    }
}
