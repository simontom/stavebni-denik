package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.*
import org.jooq.DSLContext
import java.util.UUID

object ValidationService {
    fun validateReport(tx: DSLContext, reportId: UUID): List<String> {
        val errors = mutableListOf<String>()
        val report = tx.select(
            DAILY_REPORTS.WEATHER,
            DAILY_REPORTS.WORKDESCRIPTION
        )
        .from(DAILY_REPORTS)
        .where(DAILY_REPORTS.ID.eq(reportId))
        .fetchOne() ?: return listOf("Report not found")

        val weather = report.get(DAILY_REPORTS.WEATHER)
        val description = report.get(DAILY_REPORTS.WORKDESCRIPTION)

        if (weather == null || weather.data() == "{}" || weather.data().isBlank()) {
            errors.add("Weather information is missing.")
        }
        
        if (description.isNullOrBlank()) {
            errors.add("Work description is missing.")
        }
        
        return errors
    }
}
