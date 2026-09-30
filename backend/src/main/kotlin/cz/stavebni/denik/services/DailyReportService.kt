package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.jooq.tables.references.*
import kotlinx.serialization.Serializable
import org.jooq.JSONB
import java.util.UUID
import java.time.OffsetDateTime

@Serializable
data class DailyReportDto(
    val id: String,
    val projectId: String,
    val date: String,
    val weather: WeatherData? = null,
    val generalNotes: String? = null,
    val isLocked: Boolean = false,
    val workDescription: String = "",
    val workersByTrade: String = "[]",
    val isControlDay: Boolean = false,
    val constructionObj: String? = null,
    val isSigned: Boolean = false,
    val isAcknowledged: Boolean = false,
    val photos: List<PhotoDto> = emptyList()
)

object DailyReportService {

    suspend fun createReport(
        user: SessionUser,
        projectId: UUID,
        date: String,
        workDescription: String = "",
        workersByTrade: String = "[]",
        isControlDay: Boolean = false,
        constructionObj: String? = null
    ): DailyReportDto {
        assertCan(user, Action.ReportCreate, Resource(isMember = true))

        val normalizedDateStr = if (date.contains("T")) date.substringBefore("T") else date
        val parsedDate = OffsetDateTime.parse("${normalizedDateStr}T00:00:00Z")

        return AuditService.auditedTransaction(
            actor = user,
            action = "report.create",
            entityType = "report",
            entityId = ""
        ) { tx ->
            val existing = tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.PROJECTID.eq(projectId))
                .and(DAILY_REPORTS.DATE.eq(parsedDate))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .fetchOne()

            val record = if (existing != null) {
                if (existing.lockedat != null) {
                    throw IllegalStateException("Záznam je podepsán a uzamčen, nelze jej měnit")
                }
                tx.update(DAILY_REPORTS)
                    .set(DAILY_REPORTS.WORKDESCRIPTION, workDescription)
                    .set(DAILY_REPORTS.WORKERSBYTRADE, JSONB.valueOf(workersByTrade.ifBlank { "[]" }))
                    .set(DAILY_REPORTS.ISCONTROLDAY, isControlDay)
                    .set(DAILY_REPORTS.CONSTRUCTIONOBJ, constructionObj)
                    .set(DAILY_REPORTS.UPDATEDAT, OffsetDateTime.now())
                    .where(DAILY_REPORTS.ID.eq(existing.id))
                    .returning()
                    .fetchOne() ?: throw IllegalStateException("Failed to update report")
            } else {
                val nextSeq = tx.fetchCount(DAILY_REPORTS, DAILY_REPORTS.PROJECTID.eq(projectId)) + 1

                tx.insertInto(DAILY_REPORTS)
                    .set(DAILY_REPORTS.PROJECTID, projectId)
                    .set(DAILY_REPORTS.AUTHORID, user.id)
                    .set(DAILY_REPORTS.DATE, parsedDate)
                    .set(DAILY_REPORTS.SEQUENCENUMBER, nextSeq)
                    .set(DAILY_REPORTS.WORKERSBYTRADE, JSONB.valueOf(workersByTrade.ifBlank { "[]" }))
                    .set(DAILY_REPORTS.WORKDESCRIPTION, workDescription)
                    .set(DAILY_REPORTS.ISCONTROLDAY, isControlDay)
                    .set(DAILY_REPORTS.CONSTRUCTIONOBJ, constructionObj)
                    .set(DAILY_REPORTS.WEATHER, JSONB.valueOf("{}"))
                    .returning()
                    .fetchOne() ?: throw IllegalStateException("Failed to insert report")
            }

            val reportId = record.id ?: throw IllegalStateException("Report ID is null")
            val photos = PhotoService.listPhotos(tx, reportId)

            DailyReportDto(
                id = reportId.toString(),
                projectId = record.projectid.toString(),
                date = record.date.toString().substringBefore("T"),
                weather = null,
                generalNotes = record.othernotes,
                isLocked = record.lockedat != null,
                workDescription = record.workdescription ?: "",
                workersByTrade = record.workersbytrade?.data() ?: "[]",
                isControlDay = record.iscontrolday ?: false,
                constructionObj = record.constructionobj,
                isSigned = record.signedat != null,
                isAcknowledged = record.acknowledgedat != null,
                photos = photos
            )
        }
    }

    suspend fun getReports(projectId: UUID): List<DailyReportDto> {
        val tx = DatabaseFactory.dsl
        val records = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.PROJECTID.eq(projectId))
            .and(DAILY_REPORTS.DELETEDAT.isNull)
            .orderBy(DAILY_REPORTS.DATE.desc())
            .fetch()

        val result = mutableListOf<DailyReportDto>()
        for (record in records) {
            val reportId = record.id ?: continue
            val photos = PhotoService.listPhotos(tx, reportId)
            result.add(
                DailyReportDto(
                    id = reportId.toString(),
                    projectId = record.projectid.toString(),
                    date = record.date.toString().substringBefore("T"),
                    weather = null,
                    generalNotes = record.othernotes,
                    isLocked = record.lockedat != null,
                    workDescription = record.workdescription ?: "",
                    workersByTrade = record.workersbytrade?.data() ?: "[]",
                    isControlDay = record.iscontrolday ?: false,
                    constructionObj = record.constructionobj,
                    isSigned = record.signedat != null,
                    isAcknowledged = record.acknowledgedat != null,
                    photos = photos
                )
            )
        }
        return result
    }

    suspend fun getReport(projectId: UUID, reportIdOrDate: String): DailyReportDto? {
        val tx = DatabaseFactory.dsl
        val record = try {
            val uuid = UUID.fromString(reportIdOrDate)
            tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.ID.eq(uuid))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .fetchOne()
        } catch (e: Exception) {
            val dateStr = if (reportIdOrDate.contains("T")) reportIdOrDate.substringBefore("T") else reportIdOrDate
            val parsedDate = OffsetDateTime.parse("${dateStr}T00:00:00Z")
            tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.PROJECTID.eq(projectId))
                .and(DAILY_REPORTS.DATE.eq(parsedDate))
                .and(DAILY_REPORTS.DELETEDAT.isNull)
                .fetchOne()
        } ?: return null

        val reportId = record.id ?: return null
        val photos = PhotoService.listPhotos(tx, reportId)

        return DailyReportDto(
            id = reportId.toString(),
            projectId = record.projectid.toString(),
            date = record.date.toString().substringBefore("T"),
            weather = null,
            generalNotes = record.othernotes,
            isLocked = record.lockedat != null,
            workDescription = record.workdescription ?: "",
            workersByTrade = record.workersbytrade?.data() ?: "[]",
            isControlDay = record.iscontrolday ?: false,
            constructionObj = record.constructionobj,
            isSigned = record.signedat != null,
            isAcknowledged = record.acknowledgedat != null,
            photos = photos
        )
    }

    suspend fun lockReport(user: SessionUser, reportId: UUID) {
        val tx = DatabaseFactory.dsl 
        val report = tx.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()
            ?: throw IllegalArgumentException("Not found")

        assertCan(user, Action.ReportSign, Resource(isMember = true, isLocked = report.lockedat != null))

        AuditService.auditedTransaction(
            actor = user,
            action = "report.lock",
            entityType = "report",
            entityId = reportId.toString()
        ) { t ->
            val now = OffsetDateTime.now()
            t.update(DAILY_REPORTS)
                .set(DAILY_REPORTS.LOCKEDAT, now)
                .set(DAILY_REPORTS.SIGNEDAT, now)
                .set(DAILY_REPORTS.SIGNEDBYID, user.id)
                .where(DAILY_REPORTS.ID.eq(reportId))
                .execute()
        }
    }

    suspend fun signReport(user: SessionUser, reportId: UUID) = lockReport(user, reportId)

    suspend fun acknowledgeReport(user: SessionUser, reportId: UUID) {
        val tx = DatabaseFactory.dsl 
        val report = tx.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(reportId)).fetchOne()
            ?: throw IllegalArgumentException("Not found")

        assertCan(user, Action.ReportAcknowledge, Resource(isMember = true, isLocked = report.lockedat != null))

        AuditService.auditedTransaction(
            actor = user,
            action = "report.acknowledge",
            entityType = "report",
            entityId = reportId.toString()
        ) { t ->
            t.update(DAILY_REPORTS)
                .set(DAILY_REPORTS.ACKNOWLEDGEDAT, OffsetDateTime.now())
                .set(DAILY_REPORTS.ACKNOWLEDGEDBYID, user.id)
                .where(DAILY_REPORTS.ID.eq(reportId))
                .execute()
        }
    }
}
