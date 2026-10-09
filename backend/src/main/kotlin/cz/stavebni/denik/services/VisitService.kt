package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.VISITS
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import java.time.OffsetDateTime
import java.util.UUID

@Serializable
data class VisitDto(
    val id: String,
    val reportId: String,
    val visitorName: String,
    val visitorRole: String,
    val organization: String?,
    val visitedAt: String,
    val purpose: String,
    val notes: String?
)

object VisitService {

    private fun getResourceForReport(tx: DSLContext, user: SessionUser, reportId: UUID): Resource {
        val report = tx.select(DAILY_REPORTS.PROJECTID, DAILY_REPORTS.LOCKEDAT)
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")

        val projectId = report.value1()!!
        val isLocked = report.value2() != null

        // The role in this project decides (an administrator who is not a member has none and cannot write).
        return Resource(role = ProjectAccess.roleIn(tx, user.id, projectId), isLocked = isLocked)
    }

    private fun getResourceForVisit(tx: DSLContext, user: SessionUser, visitId: UUID): Resource {
        val visit = tx.select(VISITS.REPORTID, VISITS.AUTHORID)
            .from(VISITS)
            .where(VISITS.ID.eq(visitId))
            .fetchOne() ?: throw IllegalArgumentException("Visit not found")
            
        val reportId = visit.value1()!!
        val authorId = visit.value2()
        val baseResource = getResourceForReport(tx, user, reportId)
        
        return baseResource.copy(authorId = authorId)
    }

    suspend fun createVisit(
        user: SessionUser,
        reportId: UUID,
        visitorName: String,
        visitorRole: String,
        organization: String?,
        visitedAt: OffsetDateTime,
        purpose: String,
        notes: String?
    ): VisitDto {
        return AuditService.auditedTransaction(
            actor = user,
            action = "visit.create",
            entityType = "visits",
            entityId = ""
        ) { tx ->
            assertCan(user, Action.VisitCreate, getResourceForReport(tx, user, reportId))

            val record = tx.insertInto(VISITS)
                .set(VISITS.REPORTID, reportId)
                .set(VISITS.VISITORNAME, visitorName)
                .set(VISITS.VISITORROLE, visitorRole)
                .set(VISITS.ORGANIZATION, organization)
                .set(VISITS.VISITEDAT, visitedAt)
                .set(VISITS.PURPOSE, purpose)
                .set(VISITS.NOTES, notes)
                .set(VISITS.AUTHORID, user.id)
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert visit")

            VisitDto(
                id = record.get(VISITS.ID).toString(),
                reportId = record.get(VISITS.REPORTID).toString(),
                visitorName = record.get(VISITS.VISITORNAME)!!,
                visitorRole = record.get(VISITS.VISITORROLE)!!,
                organization = record.get(VISITS.ORGANIZATION),
                visitedAt = record.get(VISITS.VISITEDAT)!!.toString(),
                purpose = record.get(VISITS.PURPOSE)!!,
                notes = record.get(VISITS.NOTES)
            )
        }
    }

    suspend fun getVisit(user: SessionUser, visitId: UUID): VisitDto {
        val tx = DatabaseFactory.dsl
        
        val record = tx.selectFrom(VISITS)
            .where(VISITS.ID.eq(visitId).and(VISITS.DELETEDAT.isNull))
            .fetchOne() ?: throw IllegalArgumentException("Visit not found")

        getResourceForVisit(tx, user, visitId).also { res ->
            if (!res.isMember) throw cz.stavebni.denik.domain.ForbiddenException(Action.VisitCreate)
        }

        return VisitDto(
            id = record.get(VISITS.ID).toString(),
            reportId = record.get(VISITS.REPORTID).toString(),
            visitorName = record.get(VISITS.VISITORNAME)!!,
            visitorRole = record.get(VISITS.VISITORROLE)!!,
            organization = record.get(VISITS.ORGANIZATION),
            visitedAt = record.get(VISITS.VISITEDAT)!!.toString(),
            purpose = record.get(VISITS.PURPOSE)!!,
            notes = record.get(VISITS.NOTES)
        )
    }

    suspend fun updateVisit(
        user: SessionUser,
        visitId: UUID,
        visitorName: String,
        visitorRole: String,
        organization: String?,
        visitedAt: OffsetDateTime,
        purpose: String,
        notes: String?
    ): VisitDto {
        return AuditService.auditedTransaction(
            actor = user,
            action = "visit.update",
            entityType = "visits",
            entityId = visitId.toString()
        ) { tx ->
            assertCan(user, Action.VisitUpdate, getResourceForVisit(tx, user, visitId))

            val record = tx.update(VISITS)
                .set(VISITS.VISITORNAME, visitorName)
                .set(VISITS.VISITORROLE, visitorRole)
                .set(VISITS.ORGANIZATION, organization)
                .set(VISITS.VISITEDAT, visitedAt)
                .set(VISITS.PURPOSE, purpose)
                .set(VISITS.NOTES, notes)
                .where(VISITS.ID.eq(visitId).and(VISITS.DELETEDAT.isNull))
                .returning()
                .fetchOne() ?: throw IllegalArgumentException("Visit not found")

            VisitDto(
                id = record.get(VISITS.ID).toString(),
                reportId = record.get(VISITS.REPORTID).toString(),
                visitorName = record.get(VISITS.VISITORNAME)!!,
                visitorRole = record.get(VISITS.VISITORROLE)!!,
                organization = record.get(VISITS.ORGANIZATION),
                visitedAt = record.get(VISITS.VISITEDAT)!!.toString(),
                purpose = record.get(VISITS.PURPOSE)!!,
                notes = record.get(VISITS.NOTES)
            )
        }
    }

    suspend fun deleteVisit(user: SessionUser, visitId: UUID) {
        AuditService.auditedTransaction(
            actor = user,
            action = "visit.delete",
            entityType = "visits",
            entityId = visitId.toString()
        ) { tx ->
            assertCan(user, Action.VisitDelete, getResourceForVisit(tx, user, visitId))

            tx.update(VISITS)
                .set(VISITS.DELETEDAT, OffsetDateTime.now())
                .where(VISITS.ID.eq(visitId).and(VISITS.DELETEDAT.isNull))
                .execute()
        }
    }
}

