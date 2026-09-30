package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class SiteHandoverServiceTest : BaseIntegrationTest() {

    @Test
    fun `full lifecycle of site handover - create, list, get, update, sign, delete`() {
        runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Handover Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))

        // 1. Create
        val dto = SiteHandoverDto(
            projectId = project.id,
            type = "PROTOCOL_ZACATEK",
            date = "2026-09-28T09:00:00Z",
            participants = "Jan Novak, Petr Stavitel",
            meterStates = listOf(MeterState(medium = "Elektřina VT", serialNumber = "EL-01", state = "12450.5 kWh")),
            notes = "Prevzeti probehlo bez zavad"
        )
        val created = SiteHandoverService.createHandover(boss, dto)
        assertNotNull(created.id)
        val handoverId = UUID.fromString(created.id)

        // 2. Get
        val fetched = SiteHandoverService.getHandover(dsl, boss, handoverId)
        assertNotNull(fetched)
        assertEquals("PROTOCOL_ZACATEK", fetched!!.type)
        assertEquals(1, fetched.meterStates?.size)
        assertEquals("12450.5 kWh", fetched.meterStates?.first()?.state)

        // 3. List
        val list = SiteHandoverService.listHandovers(dsl, boss, UUID.fromString(project.id))
        assertEquals(1, list.size)
        assertEquals(created.id, list[0].id)

        // 4. Update
        val updatedDto = fetched.copy(
            notes = "Aktualizovane poznamky",
            date = "2026-09-28T10:00:00Z"
        )
        val updated = SiteHandoverService.updateHandover(boss, handoverId, updatedDto)
        assertEquals("Aktualizovane poznamky", updated.notes)

        // 5. Delete unsigned handover
        val toDelete = SiteHandoverService.createHandover(boss, dto.copy(type = "PROTOCOL_KONEC"))
        val toDeleteId = UUID.fromString(toDelete.id)
        SiteHandoverService.deleteHandover(boss, toDeleteId)
        val deletedInDb = dsl.selectFrom(SITE_HANDOVERS).where(SITE_HANDOVERS.ID.eq(toDeleteId)).fetchOne()
        assertNotNull(deletedInDb)
        assertNotNull(deletedInDb!!.get(SITE_HANDOVERS.DELETEDAT))

        // 6. Sign
        val signed = SiteHandoverService.signHandover(boss, handoverId)
        assertNotNull(signed.signedAt)
        assertEquals(boss.id.toString(), signed.signedById)

        // 7. Attempting to delete a signed handover throws ForbiddenException
        org.junit.jupiter.api.assertThrows<cz.stavebni.denik.domain.ForbiddenException> {
            runBlocking {
                SiteHandoverService.deleteHandover(boss, handoverId)
            }
        }
    }
}
}


