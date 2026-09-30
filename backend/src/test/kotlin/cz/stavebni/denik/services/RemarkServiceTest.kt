package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.REMARKS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class RemarkServiceTest : BaseIntegrationTest() {

    @Test
    fun `full lifecycle of remarks on daily report`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Remark Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
        val reportId = UUID.fromString(report.id)

        // 1. Create Remark
        val created = RemarkService.createRemark(
            user = boss,
            reportId = reportId,
            type = "INSPECTOR_REMARK",
            text = "Zkontrolovano dodrzeni BOZP na stavenisti.",
            isOfficial = true
        )
        assertNotNull(created.id)
        val remarkId = UUID.fromString(created.id)
        assertEquals("INSPECTOR_REMARK", created.type)
        assertTrue(created.isOfficial)

        // 2. Get Remark
        val fetched = RemarkService.getRemark(boss, remarkId)
        assertEquals("Zkontrolovano dodrzeni BOZP na stavenisti.", fetched.text)

        // 3. Update Remark
        val updated = RemarkService.updateRemark(
            user = boss,
            remarkId = remarkId,
            text = "Zkontrolovano dodrzeni BOZP a pouziti OOPP.",
            isOfficial = true
        )
        assertEquals("Zkontrolovano dodrzeni BOZP a pouziti OOPP.", updated.text)

        // 4. Delete Remark
        RemarkService.deleteRemark(boss, remarkId)
        val inDb = dsl.selectFrom(REMARKS).where(REMARKS.ID.eq(remarkId)).fetchOne()
        assertNotNull(inDb)
        assertNotNull(inDb!!.get(REMARKS.DELETEDAT))
    }
}
