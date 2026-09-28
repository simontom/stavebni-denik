package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.util.UUID

class PdfExportServiceTest : BaseIntegrationTest() {

    @Test
    fun `generateReportPdf compiles report template into PDF file`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "PDF Test Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
        val reportId = UUID.fromString(report.id)

        var compilerInvoked = false
        var capturedTypstContent = ""

        // Test with custom compiler hook
        val originalCompiler = PdfExportService.compiler
        PdfExportService.compiler = TypstCompiler { _, typstFile, pdfFile ->
            compilerInvoked = true
            capturedTypstContent = typstFile.readText()
            pdfFile.writeBytes("%PDF-1.4\nMock PDF\n%%EOF".toByteArray())
        }

        try {
            val pdfFile = PdfExportService.generateReportPdf(dsl, reportId)
            assertTrue(compilerInvoked)
            assertTrue(pdfFile.exists())
            assertTrue(pdfFile.length() > 0)
            assertTrue(capturedTypstContent.contains("PDF Test Project"))
            assertTrue(capturedTypstContent.contains("Denni zaznam stavby"))
        } finally {
            PdfExportService.compiler = originalCompiler
        }
    }

    @Test
    fun `default compiler provides graceful fallback when native typst binary is absent`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(boss, ProjectDto(
            id = "", name = "Fallback PDF Project", address = "Address", cadastralArea = "Area",
            parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString()
        ))
        val report = DailyReportService.createReport(boss, UUID.fromString(project.id), "2026-09-28")
        val reportId = UUID.fromString(report.id)

        val pdfFile = PdfExportService.generateReportPdf(dsl, reportId)
        assertTrue(pdfFile.exists())
        assertTrue(pdfFile.readBytes().isNotEmpty())
    }
}
