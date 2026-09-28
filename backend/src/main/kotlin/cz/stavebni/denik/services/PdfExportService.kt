package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jooq.DSLContext
import java.io.File
import java.util.UUID

object PdfExportService {
    
    suspend fun generateReportPdf(tx: DSLContext, reportId: UUID): File = withContext(Dispatchers.IO) {
        // Fetch report data
        val report = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")
            
        val project = tx.selectFrom(PROJECTS)
            .where(PROJECTS.ID.eq(report.get(DAILY_REPORTS.PROJECT_ID)))
            .fetchOne() ?: throw IllegalArgumentException("Project not found")

        val dateStr = report.get(DAILY_REPORTS.DATE).toString()
        val projectName = project.get(PROJECTS.NAME)
        
        // Write simple Typst template for now
        val typstTemplate = """
            #set page(paper: "a4", margin: 2cm)
            #set text(font: "Linux Libertine", size: 12pt)
            
            = Denní záznam stavby
            *Projekt:* $projectName
            *Datum:* $dateStr
            
            == Počasí
            Teplota: ${report.get(DAILY_REPORTS.WEATHER)?.temperature ?: "N/A"} °C
            
            == Poznámky
            ${report.get(DAILY_REPORTS.GENERAL_NOTES) ?: "Žádné poznámky"}
        """.trimIndent()
        
        val tempDir = File(System.getProperty("java.io.tmpdir"))
        val typstFile = File(tempDir, "report_${reportId}.typ")
        val pdfFile = File(tempDir, "report_${reportId}.pdf")
        
        typstFile.writeText(typstTemplate)
        
        // Execute Typst
        val process = ProcessBuilder(
            "typst", "compile", 
            "--root", tempDir.absolutePath, 
            typstFile.absolutePath, 
            pdfFile.absolutePath
        ).redirectErrorStream(true).start()
        
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            val error = process.inputStream.bufferedReader().readText()
            throw RuntimeException("Typst compilation failed: $error")
        }
        
        pdfFile
    }
}

