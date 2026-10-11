package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.encodeToJsonElement
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

/** One member of a project as the audit log keeps it: who, and in which role. */
@Serializable
internal data class MemberSnapshot(val userId: String, val role: String)

private fun memberSnapshot(userId: UUID, role: String): kotlinx.serialization.json.JsonElement =
    kotlinx.serialization.json.Json.encodeToJsonElement(MemberSnapshot.serializer(), MemberSnapshot(userId.toString(), role))

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

    /**
     * A project always keeps its site manager as a manager: the signature of the diary is theirs. Removing them or
     * giving them another role would leave nobody who may sign, so neither is done here.
     */
    private fun requireSiteManagerStaysManager(tx: DSLContext, projectId: UUID, userId: UUID, newRole: Role?) {
        val siteManagerId = tx.select(PROJECTS.SITEMANAGERID).from(PROJECTS).where(PROJECTS.ID.eq(projectId)).fetchOne(PROJECTS.SITEMANAGERID)
        if (siteManagerId == userId && newRole != Role.BOSS) {
            throw ConflictException("Stavbyvedoucí musí zůstat členem projektu s rolí vedoucího (BOSS)")
        }
    }

    /** Whether the project still has a manager when [excluding] is left out of it. */
    private fun anotherManagerExists(tx: DSLContext, projectId: UUID, excluding: UUID): Boolean =
        tx.fetchExists(
            PROJECT_MEMBERS,
            PROJECT_MEMBERS.PROJECTID.eq(projectId)
                .and(PROJECT_MEMBERS.USERID.ne(excluding))
                .and(PROJECT_MEMBERS.ROLE.eq(DbRole.BOSS))
        )

    /**
     * Adds a member or changes the role of an existing one. Who may: a manager of the project (the role they hold *in
     * this project*), or an application administrator as the audited way in. Nobody changes their own role.
     */
    suspend fun addMember(actor: SessionUser, projectId: UUID, req: AddMemberRequest): List<ProjectMemberDto> {
        val userId = ProjectAccess.parseId(req.userId, "userId")
        val role = Role.entries.firstOrNull { it.name == req.role.trim().uppercase() }
            ?: throw IllegalArgumentException("Neznámá role: ${req.role}")

        // Who may do this: a project manager of the project, or an app administrator as the audited way in (decision D1).
        // Either way the audit row names the project, the user and the role before and after.
        AuditService.auditedWrite(actor, "project") { tx ->
            val actorRole = ProjectAccess.requireAccess(tx, actor, projectId)
            assertCan(actor, Action.ProjectMemberManage, Resource(role = actorRole))
            val userExists = tx.fetchExists(
                USERS,
                USERS.ID.eq(userId).and(USERS.DELETEDAT.isNull).and(USERS.ISACTIVE.eq(true))
            )
            if (!userExists) throw NotFoundException("Uživatel nenalezen")
            // The manager of a project signs its diary, and a signer has a ČKAIT number (decision D2).
            if (role == Role.BOSS && !ProjectAccess.hasCkaitNumber(tx, userId)) {
                throw ConflictException("Vedoucí projektu (BOSS) musí mít číslo ČKAIT. Doplňte ho nejdřív u uživatele.")
            }
            val before = tx.select(PROJECT_MEMBERS.ROLE).from(PROJECT_MEMBERS)
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId)))
                .forUpdate()
                .fetchOne(PROJECT_MEMBERS.ROLE)

            if (before != null && userId == actor.id) {
                throw ConflictException("Vlastní roli v projektu nelze měnit")
            }
            requireSiteManagerStaysManager(tx, projectId, userId, role)
            if (before == DbRole.BOSS && role != Role.BOSS && !anotherManagerExists(tx, projectId, userId)) {
                throw ConflictException("Projekt musí mít alespoň jednoho vedoucího (BOSS)")
            }

            tx.insertInto(PROJECT_MEMBERS)
                .set(PROJECT_MEMBERS.PROJECTID, projectId)
                .set(PROJECT_MEMBERS.USERID, userId)
                .set(PROJECT_MEMBERS.ROLE, DbRole.valueOf(role.name))
                .set(PROJECT_MEMBERS.ADDEDBYID, actor.id)
                .onConflict(PROJECT_MEMBERS.PROJECTID, PROJECT_MEMBERS.USERID)
                .doUpdate()
                .set(PROJECT_MEMBERS.ROLE, DbRole.valueOf(role.name))
                .execute()
            AuditService.Audited(
                result = Unit,
                action = "project.member.add",
                entityId = projectId.toString(),
                before = before?.let { memberSnapshot(userId, it.name) },
                after = memberSnapshot(userId, role.name),
            )
        }
        return listMembers(cz.stavebni.denik.db.DatabaseFactory.dsl, actor, projectId)
    }

    suspend fun removeMember(actor: SessionUser, projectId: UUID, userId: UUID) {
        AuditService.auditedWrite(actor, "project") { tx ->
            val actorRole = ProjectAccess.requireAccess(tx, actor, projectId)
            assertCan(actor, Action.ProjectMemberManage, Resource(role = actorRole))
            val before = tx.select(PROJECT_MEMBERS.ROLE).from(PROJECT_MEMBERS)
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId)))
                .forUpdate()
                .fetchOne(PROJECT_MEMBERS.ROLE) ?: throw NotFoundException("Člen projektu nenalezen")
            requireSiteManagerStaysManager(tx, projectId, userId, newRole = null)
            if (before == DbRole.BOSS && !anotherManagerExists(tx, projectId, userId)) {
                throw ConflictException("Projekt musí mít alespoň jednoho vedoucího (BOSS)")
            }
            tx.deleteFrom(PROJECT_MEMBERS)
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId)))
                .execute()
            AuditService.Audited(
                result = Unit,
                action = "project.member.remove",
                entityId = projectId.toString(),
                before = memberSnapshot(userId, before.name),
                after = null,
            )
        }
    }
}
