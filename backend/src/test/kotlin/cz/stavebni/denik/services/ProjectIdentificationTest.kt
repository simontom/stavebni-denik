package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.MINIMAL_PDF
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.StaleVersionException
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File
import java.util.UUID

/**
 * The identification of the diary (vyhláška 131/2024 Sb., příloha 12, part A): what is entered about a project, who may change
 * it, and that every change is traceable.
 */
class ProjectIdentificationTest : BaseIntegrationTest() {

    private fun dto(manager: SessionUser, name: String = "Bytový dům") = ProjectDto(
        id = "", name = name, address = "Karlova 15, Brno", cadastralArea = "Brno-střed", parcelNumbers = "450/1",
        builder = "Město Brno", contractor = "Stavitel a.s.", siteManagerId = manager.id.toString(),
    )

    private suspend fun create(manager: SessionUser, data: ProjectDto = dto(manager)): ProjectDto = ProjectService.createProject(manager, data)

    private fun stored(id: String) = dsl.selectFrom(PROJECTS).where(PROJECTS.ID.eq(UUID.fromString(id))).fetchSingle()

    private fun auditOf(action: String) = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq(action)).orderBy(AUDIT_LOG.ID.asc()).fetch()

    @Test
    fun `the manager of a project changes what is entered about it`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val created = create(boss)

        val updated = ProjectService.updateProject(
            boss, UUID.fromString(created.id),
            created.copy(
                name = "Bytový dům Zelená", permitNumber = "SZ/2026/123", permitDate = "2026-03-01", designerName = "Ing. Petr Projektant, Ph.D.",
                tdsName = "Jan Dozor", bozpName = "Eva Bozp", contractNumber = "SML-1", contractDate = "2026-04-01",
                designDocVersion = "v1.2", designDocDate = "2026-02-01",
                subcontractors = "Elektro s.r.o.\nVodoinstalace s.r.o.", supportingDocuments = "Smlouva o dílo\nStavební povolení",
            ),
        )

        assertEquals("Bytový dům Zelená", updated.name)
        assertEquals("2026-03-01", updated.permitDate)
        assertEquals("Elektro s.r.o.\nVodoinstalace s.r.o.", updated.subcontractors)
        assertNotEquals(created.updatedAt, updated.updatedAt)
        val row = stored(created.id)
        assertEquals("SZ/2026/123", row.get(PROJECTS.PERMITNUMBER))
        assertEquals("Ing. Petr Projektant, Ph.D.", row.get(PROJECTS.DESIGNERNAME))
        assertEquals("Smlouva o dílo\nStavební povolení", row.get(PROJECTS.SUPPORTINGDOCUMENTS))
    }

    @Test
    fun `creating and changing a project leave audit rows that name the project and keep what it was`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val created = create(boss)
        ProjectService.updateProject(boss, UUID.fromString(created.id), created.copy(address = "Nová 1, Brno", permitNumber = "SZ/1"))

        val createRow = auditOf("project.create").single()
        assertEquals(created.id, createRow.get(AUDIT_LOG.ENTITY_ID), "the creation names the project (it used to name none)")
        assertTrue(createRow.get(AUDIT_LOG.AFTER)!!.data().contains("Karlova 15, Brno"))

        val updateRow = auditOf("project.update").single()
        assertEquals(created.id, updateRow.get(AUDIT_LOG.ENTITY_ID))
        val before = updateRow.get(AUDIT_LOG.BEFORE)!!.data()
        val after = updateRow.get(AUDIT_LOG.AFTER)!!.data()
        assertTrue(before.contains("Karlova 15, Brno") && !before.contains("SZ/1"), before)
        assertTrue(after.contains("Nová 1, Brno") && after.contains("SZ/1"), after)
        assertTrue(AuditService.verifyChain(dsl).ok)
    }

    @Test
    fun `only the manager of this project may change it`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val created = create(boss)
        val id = UUID.fromString(created.id)
        val worker = createTestUser(role = Role.WORKER).also { addMember(id, it, Role.WORKER) }
        val inspector = createTestUser(role = Role.INSPECTOR).also { addMember(id, it, Role.INSPECTOR) }
        val investor = createTestUser(role = Role.INVESTOR).also { addMember(id, it, Role.INVESTOR) }
        val outsider = createTestUser(role = Role.BOSS)
        val admin = createTestUser(role = Role.WORKER, isAdmin = true)

        for (person in listOf(worker, inspector, investor, outsider, admin)) {
            assertThrows<ForbiddenException>("${person.role} admin=${person.isAdmin}") {
                runBlocking { ProjectService.updateProject(person, id, created.copy(name = "Cizí")) }
            }
        }
        assertEquals("Bytový dům", stored(created.id).get(PROJECTS.NAME))
        assertEquals(0, auditOf("project.update").size)
    }

    @Test
    fun `what is wrong is refused with a message and changes nothing`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val created = create(boss)
        val id = UUID.fromString(created.id)

        for (bad in listOf(
            created.copy(name = "  "),
            created.copy(address = ""),
            created.copy(builder = " "),
            created.copy(name = "x".repeat(201)),
            created.copy(subcontractors = "x".repeat(5001)),
            created.copy(permitDate = "není datum"),
            created.copy(designerName = "Novák\u0000"),
        )) {
            assertThrows<IllegalArgumentException>(bad.toString()) { runBlocking { ProjectService.updateProject(boss, id, bad) } }
        }
        assertEquals(created.name, stored(created.id).get(PROJECTS.NAME))
        assertEquals(0, auditOf("project.update").size)
    }

    @Test
    fun `the site manager is not changed by an edit`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val other = createTestUser(role = Role.BOSS)
        val created = create(boss)

        assertThrows<ConflictException> { runBlocking { ProjectService.updateProject(boss, UUID.fromString(created.id), created.copy(siteManagerId = other.id.toString())) } }
        // The same manager, as the form sends it, is fine.
        ProjectService.updateProject(boss, UUID.fromString(created.id), created.copy(name = "Nový název"))
        assertEquals(boss.id, stored(created.id).get(PROJECTS.SITEMANAGERID))
    }

    @Test
    fun `a second person who changed the project meanwhile is not overwritten`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val created = create(boss)
        val id = UUID.fromString(created.id)

        val firstSave = ProjectService.updateProject(boss, id, created.copy(name = "První"))
        // The second person still holds the version they loaded.
        assertThrows<StaleVersionException> { runBlocking { ProjectService.updateProject(boss, id, created.copy(name = "Druhý")) } }
        assertEquals("První", stored(created.id).get(PROJECTS.NAME))
        // With the version they saw last, it goes through.
        assertEquals("Druhý", ProjectService.updateProject(boss, id, firstSave.copy(name = "Druhý")).name)
    }

    @Test
    fun `an unknown project is not found`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        assertThrows<NotFoundException> { runBlocking { ProjectService.updateProject(boss, UUID.randomUUID(), dto(boss)) } }
    }

    @Test
    fun `a project is created with the new fields and without an empty required one`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)

        val created = create(boss, dto(boss).copy(permitNumber = " SZ/9 ", permitDate = "2026-01-15", subcontractors = "Firma A"))

        assertEquals("SZ/9", created.permitNumber)
        assertEquals("2026-01-15", created.permitDate)
        assertThrows<IllegalArgumentException> { runBlocking { create(boss, dto(boss).copy(address = " ")) } }
    }

    @Test
    fun `typst is given the identification of the project, only what has a value`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val created = create(boss, dto(boss).copy(permitNumber = "SZ/1", permitDate = "2026-03-01", subcontractors = "Elektro #panic(\"x\")"))
        val report = DailyReportService.createReport(boss, UUID.fromString(created.id), "2026-09-28", workDescription = "Betonáž")

        var data = ""
        var typst = ""
        PdfExportService.compiler = TypstCompiler { dir, typstFile, pdfFile ->
            typst = typstFile.readText()
            data = File(dir, "data.json").readText()
            pdfFile.writeBytes(MINIMAL_PDF)
        }
        PdfExportService.generateReportPdf(dsl, UUID.fromString(report.id))

        val json = Json.parseToJsonElement(data).jsonObject
        val rows = json["projectInfo"]!!.jsonArray.associate { it.jsonObject["label"]!!.jsonPrimitive.content to it.jsonObject["value"]!!.jsonPrimitive.content }
        assertEquals("Brno-střed", rows["Katastrální území"])
        assertEquals("Město Brno", rows["Stavebník"])
        assertEquals("SZ/1 ze dne 2026-03-01", rows["Povolení"])
        assertFalse(rows.containsKey("Projektant"), "a row without a value is left out")
        assertEquals("Elektro #panic(\"x\")", json["subcontractors"]!!.jsonPrimitive.content)
        assertEquals("", json["supportingDocuments"]!!.jsonPrimitive.content)
        assertEquals(PdfExportService.template, typst)
        assertFalse(typst.contains("panic"))
    }
}
