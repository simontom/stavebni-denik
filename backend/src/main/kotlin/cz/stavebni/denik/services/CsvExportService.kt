package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.*
import org.jooq.DSLContext
import java.util.UUID

object CsvExportService {
    fun exportReportsCsv(tx: DSLContext, projectId: UUID): String {
        val reports = tx.select(
                DAILY_REPORTS.SEQUENCENUMBER,
                DAILY_REPORTS.DATE,
                DAILY_REPORTS.WORKDESCRIPTION,
                DAILY_REPORTS.WORKSUSPENDED
            )
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.PROJECTID.eq(projectId))
            .orderBy(DAILY_REPORTS.DATE)
            .fetch()

        val sb = StringBuilder()
        sb.append("Sequence Number,Date,Work Description,Work Suspended\n")
        
        for (r in reports) {
            val seq = r.get(DAILY_REPORTS.SEQUENCENUMBER)?.toString() ?: "" // a draft has no number yet
            val date = r.get(DAILY_REPORTS.DATE)?.toString() ?: ""
            val desc = r.get(DAILY_REPORTS.WORKDESCRIPTION)?.replace("\"", "\"\"") ?: ""
            val suspended = r.get(DAILY_REPORTS.WORKSUSPENDED)
            sb.append("$seq,$date,\"$desc\",$suspended\n")
        }
        
        return sb.toString()
    }
}
