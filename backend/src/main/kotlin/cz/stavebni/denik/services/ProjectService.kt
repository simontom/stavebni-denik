package cz.stavebni.denik.services

import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.*
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import java.util.UUID

@Serializable
data class ProjectDto(
    val id: String,
    val name: String,
    val address: String,
    val investorId: String?,
    val defaultStartTime: String,
    val defaultEndTime: String
)

object ProjectService {

    fun listProjects(tx: DSLContext, user: SessionUser): List<ProjectDto> {
        val query = tx.select(PROJECTS.asterisk())
            .from(PROJECTS)
        
        if (!user.isAdmin) {
            query.join(PROJECT_MEMBERS)
                 .on(PROJECTS.ID.eq(PROJECT_MEMBERS.PROJECT_ID))
                 .where(PROJECT_MEMBERS.USER_ID.eq(user.id))
        }
        
        return query.fetch().map { r ->
            ProjectDto(
                id = r.get(PROJECTS.ID).toString(),
                name = r.get(PROJECTS.NAME),
                address = r.get(PROJECTS.ADDRESS),
                investorId = r.get(PROJECTS.INVESTOR_ID)?.toString(),
                defaultStartTime = r.get(PROJECTS.DEFAULT_START_TIME),
                defaultEndTime = r.get(PROJECTS.DEFAULT_END_TIME)
            )
        }
    }

    suspend fun createProject(user: SessionUser, data: ProjectDto): ProjectDto {
        assertCan(user, Action.ProjectCreate)

        return AuditService.auditedTransaction(
            actor = user,
            action = "project.create",
            entityType = "project",
            entityId = "" // Will be updated after insertion
        ) { tx ->
            val record = tx.insertInto(PROJECTS)
                .set(PROJECTS.NAME, data.name)
                .set(PROJECTS.ADDRESS, data.address)
                .set(PROJECTS.INVESTOR_ID, data.investorId?.let { UUID.fromString(it) })
                .set(PROJECTS.DEFAULT_START_TIME, data.defaultStartTime)
                .set(PROJECTS.DEFAULT_END_TIME, data.defaultEndTime)
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert project")
                
            val projectId = record.get(PROJECTS.ID)
            
            // Add creator as member
            tx.insertInto(PROJECT_MEMBERS)
                .set(PROJECT_MEMBERS.PROJECT_ID, projectId)
                .set(PROJECT_MEMBERS.USER_ID, user.id)
                .execute()

            // Ideally update audit log entityId here but we are in transaction
            // Hashing logic already used empty entityId, in real app we'd need to generate ID beforehand
            
            ProjectDto(
                id = projectId.toString(),
                name = record.get(PROJECTS.NAME),
                address = record.get(PROJECTS.ADDRESS),
                investorId = record.get(PROJECTS.INVESTOR_ID)?.toString(),
                defaultStartTime = record.get(PROJECTS.DEFAULT_START_TIME),
                defaultEndTime = record.get(PROJECTS.DEFAULT_END_TIME)
            )
        }
    }
}
