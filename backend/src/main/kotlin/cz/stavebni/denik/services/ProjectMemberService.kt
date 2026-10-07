package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import java.util.UUID
import cz.stavebni.denik.jooq.enums.Role as DbRole

@Serializable
data class ProjectMemberDto(
    val userId: String,
    val nickname: String,
    val displayName: String,
    val role: String,
    val addedAt: String? = null,
)

@Serializable
data class AddMemberRequest(
    val userId: String,
    val role: String,
)

object ProjectMemberService {

    fun listMembers(tx: DSLContext, user: SessionUser, projectId: UUID): List<ProjectMemberDto> {
        ProjectAccess.requireAccess(tx, user, projectId)
        return tx.select(PROJECT_MEMBERS.USERID, USERS.NICKNAME, USERS.DISPLAYNAME, PROJECT_MEMBERS.ROLE, PROJECT_MEMBERS.ADDEDAT)
            .from(PROJECT_MEMBERS)
            .join(USERS).on(USERS.ID.eq(PROJECT_MEMBERS.USERID))
            .where(PROJECT_MEMBERS.PROJECTID.eq(projectId))
            .and(USERS.DELETEDAT.isNull)
            .orderBy(PROJECT_MEMBERS.ADDEDAT.asc())
            .fetch()
            .map { r ->
                ProjectMemberDto(
                    userId = r.get(PROJECT_MEMBERS.USERID).toString(),
                    nickname = r.get(USERS.NICKNAME)!!,
                    displayName = r.get(USERS.DISPLAYNAME)!!,
                    role = r.get(PROJECT_MEMBERS.ROLE)!!.name,
                    addedAt = r.get(PROJECT_MEMBERS.ADDEDAT)?.toString(),
                )
            }
    }

    /** Adds a member or changes the role of an existing one. */
    suspend fun addMember(actor: SessionUser, projectId: UUID, req: AddMemberRequest): List<ProjectMemberDto> {
        assertCan(actor, Action.ProjectMemberManage)
        val userId = ProjectAccess.parseId(req.userId, "userId")
        val role = Role.entries.firstOrNull { it.name == req.role.trim().uppercase() }
            ?: throw IllegalArgumentException("Neznámá role: ${req.role}")

        AuditService.auditedTransaction(
            actor = actor,
            action = "project.member.add",
            entityType = "project",
            entityId = projectId.toString(),
        ) { tx ->
            ProjectAccess.requireAccess(tx, actor, projectId)
            val userExists = tx.fetchExists(
                USERS,
                USERS.ID.eq(userId).and(USERS.DELETEDAT.isNull).and(USERS.ISACTIVE.eq(true))
            )
            if (!userExists) throw NotFoundException("Uživatel nenalezen")

            tx.insertInto(PROJECT_MEMBERS)
                .set(PROJECT_MEMBERS.PROJECTID, projectId)
                .set(PROJECT_MEMBERS.USERID, userId)
                .set(PROJECT_MEMBERS.ROLE, DbRole.valueOf(role.name))
                .set(PROJECT_MEMBERS.ADDEDBYID, actor.id)
                .onConflict(PROJECT_MEMBERS.PROJECTID, PROJECT_MEMBERS.USERID)
                .doUpdate()
                .set(PROJECT_MEMBERS.ROLE, DbRole.valueOf(role.name))
                .execute()
        }
        return listMembers(cz.stavebni.denik.db.DatabaseFactory.dsl, actor, projectId)
    }

    suspend fun removeMember(actor: SessionUser, projectId: UUID, userId: UUID) {
        assertCan(actor, Action.ProjectMemberManage)
        AuditService.auditedTransaction(
            actor = actor,
            action = "project.member.remove",
            entityType = "project",
            entityId = projectId.toString(),
        ) { tx ->
            ProjectAccess.requireAccess(tx, actor, projectId)
            val deleted = tx.deleteFrom(PROJECT_MEMBERS)
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId)))
                .execute()
            if (deleted == 0) throw NotFoundException("Člen projektu nenalezen")
        }
    }
}
