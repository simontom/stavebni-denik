package cz.stavebni.denik.services

import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.jooq.tables.references.*
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import org.jooq.JSONB
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID
import java.time.OffsetDateTime

@Serializable
data class DailyReportDto(
    val id: String,
    val projectId: String,
    val date: String,
    val weather: WeatherData?,
    val generalNotes: String?,
    val isLocked: Boolean
)

object DailyReportService {
    private val json = Json { encodeDefaults = true }

    suspend fun createReport(user: SessionUser, projectId: UUID, date: String): DailyReportDto {
        assertCan(user, Action.ReportCreate, Resource(isMember = true))

        return AuditService.auditedTransaction(
            actor = user,
            action = "report.create",
            entityType = "report",
            entityId = ""
        ) { tx ->
            val record = tx.insertInto(DAILY_REPORTS)
                .set(DAILY_REPORTS.PROJECTID, projectId)
                .set(DAILY_REPORTS.AUTHORID, user.id)
                .set(DAILY_REPORTS.DATE, OffsetDateTime.parse(date + "T00:00:00Z"))
                .set(DAILY_REPORTS.SEQUENCENUMBER, 1)
                .set(DAILY_REPORTS.WORKERSBYTRADE, JSONB.valueOf("[]"))
                .set(DAILY_REPORTS.WORKDESCRIPTION, "")
                .set(DAILY_REPORTS.WEATHER, JSONB.valueOf("{}"))
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert report")
                
            DailyReportDto(
                id = record.get(DAILY_REPORTS.ID).toString(),
                projectId = record.get(DAILY_REPORTS.PROJECTID).toString(),
                date = record.get(DAILY_REPORTS.DATE).toString(),
                weather = null,
                generalNotes = null,
                isLocked = record.get(DAILY_REPORTS.LOCKEDAT) != null
            )
        }
    }

    suspend fun lockReport(user: SessionUser, reportId: UUID) {
        val tx = cz.stavebni.denik.db.DatabaseFactory.dsl 
        val report = tx.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()
            ?: throw IllegalArgumentException("Not found")

        assertCan(user, Action.ReportSign, Resource(isMember = true, isLocked = report.get(DAILY_REPORTS.LOCKEDAT) != null))

        AuditService.auditedTransaction(
            actor = user,
            action = "report.lock",
            entityType = "report",
            entityId = reportId.toString()
        ) { t ->
            t.update(DAILY_REPORTS)
                .set(DAILY_REPORTS.LOCKEDAT, OffsetDateTime.now())
                .where(DAILY_REPORTS.ID.eq(reportId))
                .execute()
        }
    }
}
