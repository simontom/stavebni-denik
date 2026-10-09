package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.enums.Remarktype
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.REMARKS
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import java.time.OffsetDateTime
import java.util.UUID

@Serializable
data class RemarkDto(
    val id: String,
    val reportId: String,
    val authorId: String,
    val type: String,
    val text: String,
    val isOfficial: Boolean
)

object RemarkService {

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

    private fun getResourceForRemark(tx: DSLContext, user: SessionUser, remarkId: UUID): Resource {
        val remark = tx.select(REMARKS.REPORTID, REMARKS.AUTHORID)
            .from(REMARKS)
            .where(REMARKS.ID.eq(remarkId))
            .fetchOne() ?: throw IllegalArgumentException("Remark not found")
            
        val reportId = remark.value1()!!
        val authorId = remark.value2()
        val baseResource = getResourceForReport(tx, user, reportId)
        
        return baseResource.copy(authorId = authorId)
    }

    suspend fun createRemark(
        user: SessionUser,
        reportId: UUID,
        type: String,
        text: String,
        isOfficial: Boolean
    ): RemarkDto {
        return AuditService.auditedTransaction(
            actor = user,
            action = "remark.create",
            entityType = "remarks",
            entityId = ""
        ) { tx ->
            assertCan(user, Action.RemarkCreate, getResourceForReport(tx, user, reportId))

            val record = tx.insertInto(REMARKS)
                .set(REMARKS.REPORTID, reportId)
                .set(REMARKS.AUTHORID, user.id)
                .set(REMARKS.TYPE, Remarktype.valueOf(type))
                .set(REMARKS.TEXT, text)
                .set(REMARKS.ISOFFICIAL, isOfficial)
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert remark")

            RemarkDto(
                id = record.get(REMARKS.ID).toString(),
                reportId = record.get(REMARKS.REPORTID).toString(),
                authorId = record.get(REMARKS.AUTHORID).toString(),
                type = record.get(REMARKS.TYPE)!!.name,
                text = record.get(REMARKS.TEXT)!!,
                isOfficial = record.get(REMARKS.ISOFFICIAL)!!
            )
        }
    }

    suspend fun getRemark(user: SessionUser, remarkId: UUID): RemarkDto {
        val tx = DatabaseFactory.dsl
        
        val record = tx.selectFrom(REMARKS)
            .where(REMARKS.ID.eq(remarkId).and(REMARKS.DELETEDAT.isNull))
            .fetchOne() ?: throw IllegalArgumentException("Remark not found")

        getResourceForRemark(tx, user, remarkId).also { res ->
            if (!res.isMember) throw cz.stavebni.denik.domain.ForbiddenException(Action.RemarkCreate)
        }

        return RemarkDto(
            id = record.get(REMARKS.ID).toString(),
            reportId = record.get(REMARKS.REPORTID).toString(),
            authorId = record.get(REMARKS.AUTHORID).toString(),
            type = record.get(REMARKS.TYPE)!!.name,
            text = record.get(REMARKS.TEXT)!!,
            isOfficial = record.get(REMARKS.ISOFFICIAL)!!
        )
    }

    suspend fun updateRemark(
        user: SessionUser,
        remarkId: UUID,
        text: String,
        isOfficial: Boolean
    ): RemarkDto {
        return AuditService.auditedTransaction(
            actor = user,
            action = "remark.update",
            entityType = "remarks",
            entityId = remarkId.toString()
        ) { tx ->
            assertCan(user, Action.RemarkUpdate, getResourceForRemark(tx, user, remarkId))

            val record = tx.update(REMARKS)
                .set(REMARKS.TEXT, text)
                .set(REMARKS.ISOFFICIAL, isOfficial)
                .where(REMARKS.ID.eq(remarkId).and(REMARKS.DELETEDAT.isNull))
                .returning()
                .fetchOne() ?: throw IllegalArgumentException("Remark not found")

            RemarkDto(
                id = record.get(REMARKS.ID).toString(),
                reportId = record.get(REMARKS.REPORTID).toString(),
                authorId = record.get(REMARKS.AUTHORID).toString(),
                type = record.get(REMARKS.TYPE)!!.name,
                text = record.get(REMARKS.TEXT)!!,
                isOfficial = record.get(REMARKS.ISOFFICIAL)!!
            )
        }
    }

    suspend fun deleteRemark(user: SessionUser, remarkId: UUID) {
        AuditService.auditedTransaction(
            actor = user,
            action = "remark.delete",
            entityType = "remarks",
            entityId = remarkId.toString()
        ) { tx ->
            assertCan(user, Action.RemarkDelete, getResourceForRemark(tx, user, remarkId))

            tx.update(REMARKS)
                .set(REMARKS.DELETEDAT, OffsetDateTime.now())
                .where(REMARKS.ID.eq(remarkId).and(REMARKS.DELETEDAT.isNull))
                .execute()
        }
    }
}

