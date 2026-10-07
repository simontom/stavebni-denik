package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.MATERIAL_NEEDS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.OffsetDateTime
import java.util.UUID

class MaterialServiceTest : BaseIntegrationTest() {

    @Test
    fun `full lifecycle of material need - create, read, update, resolve, delete`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Material Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val projectId = UUID.fromString(project.id)
        val report = DailyReportService.createReport(boss, projectId, "2026-09-28")
        val reportId = UUID.fromString(report.id)

        // 1. Create
        val neededBy = OffsetDateTime.now().plusDays(2)
        val created = MaterialService.createMaterial(boss, reportId, "50x Pytel cementu CEM II", neededBy)
        assertNotNull(created.id)
        assertEquals("50x Pytel cementu CEM II", created.text)
        assertFalse(created.isProvided)

        val materialId = UUID.fromString(created.id)

        // 2. Read
        val fetched = MaterialService.getMaterial(boss, materialId)
        assertEquals(created.id, fetched.id)
        assertEquals("50x Pytel cementu CEM II", fetched.text)

        // 3. Update
        val updated = MaterialService.updateMaterial(boss, materialId, "60x Pytel cementu CEM II", neededBy)
        assertEquals("60x Pytel cementu CEM II", updated.text)

        // 4. Resolve
        MaterialService.resolveMaterial(boss, materialId)
        val resolved = MaterialService.getMaterial(boss, materialId)
        assertTrue(resolved.isProvided)

        val inDb = dsl.selectFrom(MATERIAL_NEEDS).where(MATERIAL_NEEDS.ID.eq(materialId)).fetchOne()
        assertNotNull(inDb)
        assertTrue(inDb!!.get(MATERIAL_NEEDS.RESOLVED)!!)
        assertEquals(boss.id, inDb.get(MATERIAL_NEEDS.RESOLVEDBYID))
        assertNotNull(inDb.get(MATERIAL_NEEDS.RESOLVEDAT))

        // 5. Delete (Soft delete)
        MaterialService.deleteMaterial(boss, materialId)
        val deletedInDb = dsl.selectFrom(MATERIAL_NEEDS).where(MATERIAL_NEEDS.ID.eq(materialId)).fetchOne()
        assertNotNull(deletedInDb)
        assertNotNull(deletedInDb!!.get(MATERIAL_NEEDS.DELETEDAT))
    }
}
