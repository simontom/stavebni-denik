package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.VISITS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.OffsetDateTime
import java.util.UUID

class VisitServiceTest : BaseIntegrationTest() {

    @Test
    fun `full lifecycle of visit on daily report`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Visit Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
        val reportId = UUID.fromString(report.id)

        // 1. Create Visit
        val visitedAt = OffsetDateTime.now()
        val created = VisitService.createVisit(
            user = boss,
            reportId = reportId,
            visitorName = "Ing. Karel Dvorak",
            visitorRole = "Technicky dozor investora (TDI)",
            organization = "Dozor s.r.o.",
            visitedAt = visitedAt,
            purpose = "Kontrola armovani zakladove desky",
            notes = "Bez vyhrad, mozno betonovat"
        )
        assertNotNull(created.id)
        val visitId = UUID.fromString(created.id)

        // 2. Get Visit
        val fetched = VisitService.getVisit(boss, visitId)
        assertEquals("Ing. Karel Dvorak", fetched.visitorName)
        assertEquals("Dozor s.r.o.", fetched.organization)

        // 3. Update Visit
        val updated = VisitService.updateVisit(
            user = boss,
            visitId = visitId,
            visitorName = "Ing. Karel Dvorak, Ph.D.",
            visitorRole = "TDI",
            organization = "Dozor s.r.o.",
            visitedAt = visitedAt,
            purpose = "Kontrola armovani a hydroizolace",
            notes = "Doporuceno zlepsit prekryti"
        )
        assertEquals("Ing. Karel Dvorak, Ph.D.", updated.visitorName)
        assertEquals("Kontrola armovani a hydroizolace", updated.purpose)

        // 4. Delete Visit
        VisitService.deleteVisit(boss, visitId)
        val inDb = dsl.selectFrom(VISITS).where(VISITS.ID.eq(visitId)).fetchOne()
        assertNotNull(inDb)
        assertNotNull(inDb!!.get(VISITS.DELETEDAT))
    }
}
