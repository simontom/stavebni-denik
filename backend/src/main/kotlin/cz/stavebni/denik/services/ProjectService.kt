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
    val cadastralArea: String,
    val parcelNumbers: String,
    val builder: String,
    val contractor: String,
    val siteManagerId: String
)

object ProjectService {

    fun listProjects(tx: DSLContext, user: SessionUser): List<ProjectDto> {
        val query = tx.select(PROJECTS.asterisk())
            .from(PROJECTS)
        
        if (!user.isAdmin) {
            query.join(PROJECT_MEMBERS)
                 .on(PROJECTS.ID.eq(PROJECT_MEMBERS.PROJECTID))
                 .where(PROJECT_MEMBERS.USERID.eq(user.id))
        }
        
        return query.fetch().map { r ->
            ProjectDto(
                id = r.get(PROJECTS.ID).toString(),
                name = r.get(PROJECTS.NAME)!!,
                address = r.get(PROJECTS.ADDRESS)!!,
                cadastralArea = r.get(PROJECTS.CADASTRALAREA)!!,
                parcelNumbers = r.get(PROJECTS.PARCELNUMBERS)!!,
                builder = r.get(PROJECTS.BUILDER)!!,
                contractor = r.get(PROJECTS.CONTRACTOR)!!,
                siteManagerId = r.get(PROJECTS.SITEMANAGERID).toString()
            )
        }
    }

    suspend fun createProject(user: SessionUser, data: ProjectDto): ProjectDto {
        assertCan(user, Action.ProjectCreate)

        return AuditService.auditedTransaction(
            actor = user,
            action = "project.create",
            entityType = "project",
            entityId = "" 
        ) { tx ->
            val record = tx.insertInto(PROJECTS)
                .set(PROJECTS.NAME, data.name)
                .set(PROJECTS.ADDRESS, data.address)
                .set(PROJECTS.CADASTRALAREA, data.cadastralArea)
                .set(PROJECTS.PARCELNUMBERS, data.parcelNumbers)
                .set(PROJECTS.BUILDER, data.builder)
                .set(PROJECTS.CONTRACTOR, data.contractor)
                .set(PROJECTS.SITEMANAGERID, UUID.fromString(data.siteManagerId))
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert project")
                
            val projectId = record.get(PROJECTS.ID)
            
            tx.insertInto(PROJECT_MEMBERS)
                .set(PROJECT_MEMBERS.PROJECTID, projectId)
                .set(PROJECT_MEMBERS.USERID, user.id)
                .execute()
            
            ProjectDto(
                id = projectId.toString(),
                name = record.get(PROJECTS.NAME)!!,
                address = record.get(PROJECTS.ADDRESS)!!,
                cadastralArea = record.get(PROJECTS.CADASTRALAREA)!!,
                parcelNumbers = record.get(PROJECTS.PARCELNUMBERS)!!,
                builder = record.get(PROJECTS.BUILDER)!!,
                contractor = record.get(PROJECTS.CONTRACTOR)!!,
                siteManagerId = record.get(PROJECTS.SITEMANAGERID).toString()
            )
        }
    }
}

