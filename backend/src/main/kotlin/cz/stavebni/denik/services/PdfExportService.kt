package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jooq.DSLContext
import java.io.File
import java.util.UUID

object PdfExportService {
    
    suspend fun generateReportPdf(tx: DSLContext, reportId: UUID): File = withContext(Dispatchers.IO) {
        val report = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")
            
        val project = tx.selectFrom(PROJECTS)
            .where(PROJECTS.ID.eq(report.get(DAILY_REPORTS.PROJECTID)))
            .fetchOne() ?: throw IllegalArgumentException("Project not found")

        val dateStr = report.get(DAILY_REPORTS.DATE).toString()
        val projectName = project.get(PROJECTS.NAME)
        
        val weatherJson = report.get(DAILY_REPORTS.WEATHER)?.data() ?: "{}"
        val workDescription = report.get(DAILY_REPORTS.WORKDESCRIPTION) ?: ""
        
        val typstTemplate = """
            #set page(paper: "a4", margin: 2cm)
            #set text(font: "Linux Libertine", size: 12pt)
            
            = Denní záznam stavby
            *Projekt:* ${projectName}
            *Datum:* ${dateStr}
            
            == Pocasí
            ${weatherJson}
            
            == Popis prací
            ${workDescription}
        """.trimIndent()
        
        val tempDir = File(System.getProperty("java.io.tmpdir"))
        val typstFile = File(tempDir, "report_$reportId.typ")
        val pdfFile = File(tempDir, "report_$reportId.pdf")
        
        typstFile.writeText(typstTemplate)
        
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
