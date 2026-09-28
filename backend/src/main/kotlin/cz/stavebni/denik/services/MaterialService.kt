package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.MATERIAL_NEEDS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import java.time.OffsetDateTime
import java.util.UUID

@Serializable
data class MaterialNeedDto(
    val id: String,
    val reportId: String,
    val text: String,
    val neededBy: String?,
    val isProvided: Boolean
)

object MaterialService {

    private fun getResourceForReport(tx: DSLContext, user: SessionUser, reportId: UUID): Resource {
        val report = tx.select(DAILY_REPORTS.PROJECTID, DAILY_REPORTS.LOCKEDAT)
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId))
            .fetchOne() ?: throw IllegalArgumentException("Report not found")

        val projectId = report.value1()
        val isLocked = report.value2() != null

        val isMember = tx.selectCount()
            .from(PROJECT_MEMBERS)
            .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(user.id)))
            .fetchOne(0, Int::class.java) ?: 0 > 0

        return Resource(isMember = isMember || user.isAdmin, isLocked = isLocked)
    }

    private fun getResourceForMaterial(tx: DSLContext, user: SessionUser, materialId: UUID): Resource {
        val material = tx.select(MATERIAL_NEEDS.REPORTID, MATERIAL_NEEDS.CREATEDBYID)
            .from(MATERIAL_NEEDS)
            .where(MATERIAL_NEEDS.ID.eq(materialId))
            .fetchOne() ?: throw IllegalArgumentException("Material need not found")
            
        val reportId = material.value1()!!
        val authorId = material.value2()
        val baseResource = getResourceForReport(tx, user, reportId)
        
        return baseResource.copy(authorId = authorId)
    }

    suspend fun createMaterial(user: SessionUser, reportId: UUID, text: String, neededBy: OffsetDateTime?): MaterialNeedDto {
        return AuditService.auditedTransaction(
            actor = user,
            action = "material.create",
            entityType = "material_needs",
            entityId = ""
        ) { tx ->
            assertCan(user, Action.MaterialCreate, getResourceForReport(tx, user, reportId))

            val record = tx.insertInto(MATERIAL_NEEDS)
                .set(MATERIAL_NEEDS.REPORTID, reportId)
                .set(MATERIAL_NEEDS.TEXT, text)
                .set(MATERIAL_NEEDS.NEEDEDBY, neededBy)
                .set(MATERIAL_NEEDS.CREATEDBYID, user.id)
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert material need")

            MaterialNeedDto(
                id = record.get(MATERIAL_NEEDS.ID).toString(),
                reportId = record.get(MATERIAL_NEEDS.REPORTID).toString(),
                text = record.get(MATERIAL_NEEDS.TEXT)!!,
                neededBy = record.get(MATERIAL_NEEDS.NEEDEDBY)?.toString(),
                isProvided = record.get(MATERIAL_NEEDS.RESOLVED)!!
            )
        }
    }

    suspend fun getMaterial(user: SessionUser, materialId: UUID): MaterialNeedDto {
        // Just read using DatabaseFactory.dsl
        val tx = DatabaseFactory.dsl
        
        val record = tx.selectFrom(MATERIAL_NEEDS)
            .where(MATERIAL_NEEDS.ID.eq(materialId).and(MATERIAL_NEEDS.DELETEDAT.isNull))
            .fetchOne() ?: throw IllegalArgumentException("Material need not found")

        // check access
        getResourceForMaterial(tx, user, materialId).also { res ->
            if (!res.isMember) throw cz.stavebni.denik.domain.ForbiddenException(Action.MaterialCreate)
        }

        return MaterialNeedDto(
            id = record.get(MATERIAL_NEEDS.ID).toString(),
            reportId = record.get(MATERIAL_NEEDS.REPORTID).toString(),
            text = record.get(MATERIAL_NEEDS.TEXT)!!,
            neededBy = record.get(MATERIAL_NEEDS.NEEDEDBY)?.toString(),
            isProvided = record.get(MATERIAL_NEEDS.RESOLVED)!!
        )
    }

    suspend fun updateMaterial(user: SessionUser, materialId: UUID, text: String, neededBy: OffsetDateTime?): MaterialNeedDto {
        return AuditService.auditedTransaction(
            actor = user,
            action = "material.update",
            entityType = "material_needs",
            entityId = materialId.toString()
        ) { tx ->
            assertCan(user, Action.MaterialUpdate, getResourceForMaterial(tx, user, materialId))

            val record = tx.update(MATERIAL_NEEDS)
                .set(MATERIAL_NEEDS.TEXT, text)
                .set(MATERIAL_NEEDS.NEEDEDBY, neededBy)
                .where(MATERIAL_NEEDS.ID.eq(materialId).and(MATERIAL_NEEDS.DELETEDAT.isNull))
                .returning()
                .fetchOne() ?: throw IllegalArgumentException("Material need not found")

            MaterialNeedDto(
                id = record.get(MATERIAL_NEEDS.ID).toString(),
                reportId = record.get(MATERIAL_NEEDS.REPORTID).toString(),
                text = record.get(MATERIAL_NEEDS.TEXT)!!,
                neededBy = record.get(MATERIAL_NEEDS.NEEDEDBY)?.toString(),
                isProvided = record.get(MATERIAL_NEEDS.RESOLVED)!!
            )
        }
    }

    suspend fun deleteMaterial(user: SessionUser, materialId: UUID) {
        AuditService.auditedTransaction(
            actor = user,
            action = "material.delete",
            entityType = "material_needs",
            entityId = materialId.toString()
        ) { tx ->
            assertCan(user, Action.MaterialDelete, getResourceForMaterial(tx, user, materialId))

            tx.update(MATERIAL_NEEDS)
                .set(MATERIAL_NEEDS.DELETEDAT, OffsetDateTime.now())
                .where(MATERIAL_NEEDS.ID.eq(materialId).and(MATERIAL_NEEDS.DELETEDAT.isNull))
                .execute()
        }
    }

    suspend fun resolveMaterial(user: SessionUser, materialId: UUID) {
        AuditService.auditedTransaction(
            actor = user,
            action = "material.resolve",
            entityType = "material_needs",
            entityId = materialId.toString()
        ) { tx ->
            assertCan(user, Action.MaterialResolve, getResourceForMaterial(tx, user, materialId))

            tx.update(MATERIAL_NEEDS)
                .set(MATERIAL_NEEDS.RESOLVED, true)
                .set(MATERIAL_NEEDS.RESOLVEDAT, OffsetDateTime.now())
                .set(MATERIAL_NEEDS.RESOLVEDBYID, user.id)
                .where(MATERIAL_NEEDS.ID.eq(materialId).and(MATERIAL_NEEDS.DELETEDAT.isNull))
                .execute()
        }
    }
}
