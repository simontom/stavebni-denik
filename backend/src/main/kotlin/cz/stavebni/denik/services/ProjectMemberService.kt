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
import cz.stavebni.denik.util.Text
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
    /** The scope of the person's authorisation and responsibility (příloha 12 A d)); only a manager (BOSS) or a member of the supervision (INSPECTOR) has one. */
    val scope: String? = null,
    val addedAt: String? = null,
)

@Serializable
data class AddMemberRequest(
    val userId: String,
    val role: String,
    /**
     * The scope of the person's authorisation and responsibility: what they ensure and answer for on this build (at most
     * [ProjectMemberService.MAX_SCOPE_CHARS] characters). Not mentioned: an existing member keeps what they have; an empty
     * text clears it. Only for a manager (BOSS) or a member of the supervision (INSPECTOR): for any other role it is a 400.
     */
    val scope: String? = null,
)

/** One member of a project as the audit log keeps it: who, in which role and with which scope (left out when there is none). */
@Serializable
internal data class MemberSnapshot(val userId: String, val role: String, val scope: String? = null)

internal fun memberSnapshot(userId: UUID, role: String, scope: String? = null): kotlinx.serialization.json.JsonElement =
    kotlinx.serialization.json.Json.encodeToJsonElement(MemberSnapshot.serializer(), MemberSnapshot(userId.toString(), role, scope))

object ProjectMemberService {

    /** The longest scope of authorisation and responsibility, like the authorisation of an authorised person (A7). */
    const val MAX_SCOPE_CHARS = 500

    /** The roles whose members are named in part A of the diary, with their scope (BOSS and INSPECTOR): the only ones that have a scope. */
    private val ROLES_WITH_SCOPE = listOf(DbRole.BOSS, DbRole.INSPECTOR)

    fun listMembers(tx: DSLContext, user: SessionUser, projectId: UUID): List<ProjectMemberDto> {
        ProjectAccess.requireAccess(tx, user, projectId)
        return tx.select(PROJECT_MEMBERS.USERID, USERS.NICKNAME, USERS.DISPLAYNAME, PROJECT_MEMBERS.ROLE, PROJECT_MEMBERS.SCOPE, PROJECT_MEMBERS.ADDEDAT)
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
                    scope = r.get(PROJECT_MEMBERS.SCOPE),
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

    /**
     * Whether the project still has a manager when [excluding] is left out of it. Only an ACTIVE user counts: a manager whose
     * account is deactivated or deleted cannot sign in, so a project whose other managers are all like that has none.
     */
    private fun anotherManagerExists(tx: DSLContext, projectId: UUID, excluding: UUID): Boolean =
        tx.fetchExists(
            tx.selectOne()
                .from(PROJECT_MEMBERS)
                .join(USERS).on(USERS.ID.eq(PROJECT_MEMBERS.USERID))
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId))
                .and(PROJECT_MEMBERS.USERID.ne(excluding))
                .and(PROJECT_MEMBERS.ROLE.eq(DbRole.BOSS))
                .and(USERS.ISACTIVE.eq(true))
                .and(USERS.DELETEDAT.isNull)
        )

    /**
     * Adds a member or changes the role or the scope of an existing one. Who may: a manager of the project (the role they hold
     * *in this project*), or an application administrator as the audited way in. Nobody changes their own role (they may state
     * their own scope: a manager who is the only one has nobody else to do it).
     *
     * The scope of authorisation and responsibility is for a manager (BOSS) and a member of the supervision (INSPECTOR), the
     * persons part A of the diary names (příloha 12 A d)); a member of another role has none, and one that is given is a 400.
     * A scope that the request does not mention is kept; an empty one clears it. A project has at most
     * [PartASnapshot.MAX_PERSONS] such members, so that part A, which is stored with every signature, stays small.
     */
    suspend fun addMember(actor: SessionUser, projectId: UUID, req: AddMemberRequest): List<ProjectMemberDto> {
        val userId = ProjectAccess.parseId(req.userId, "userId")
        val role = Role.entries.firstOrNull { it.name == req.role.trim().uppercase() }
            ?: throw IllegalArgumentException("Neznámá role: ${req.role}")
        val newDbRole = DbRole.valueOf(role.name)
        // null: not mentioned; "": cleared.
        val scopeGiven: String? = req.scope?.trim()?.let { Text.checked(it, "Rozsah oprávnění a odpovědnosti", MAX_SCOPE_CHARS) }
        require(scopeGiven.isNullOrEmpty() || newDbRole in ROLES_WITH_SCOPE) {
            "Rozsah oprávnění a odpovědnosti lze uvést jen u stavbyvedoucího (BOSS) a technického dozoru (INSPECTOR)"
        }

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
                throw ConflictException("Vedoucí projektu (BOSS) musí mít číslo ČKAIT. Číslo doplňuje administrátor v seznamu uživatelů: požádejte ho o to.")
            }
            val existing = tx.select(PROJECT_MEMBERS.ROLE, PROJECT_MEMBERS.SCOPE).from(PROJECT_MEMBERS)
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId)))
                .forUpdate()
                .fetchOne()
            val before = existing?.get(PROJECT_MEMBERS.ROLE)

            // Nobody changes their own role. Stating their own scope, in the role they hold, is not a change of role.
            if (before != null && userId == actor.id && before != newDbRole) {
                throw ConflictException("Vlastní roli v projektu nelze měnit")
            }
            requireSiteManagerStaysManager(tx, projectId, userId, role)
            if (before == DbRole.BOSS && role != Role.BOSS && !anotherManagerExists(tx, projectId, userId)) {
                throw ConflictException("Projekt musí mít alespoň jednoho aktivního vedoucího (BOSS)")
            }
            // Part A of the diary names these persons and is stored with every signature: their number is bounded.
            if (newDbRole in ROLES_WITH_SCOPE && before !in ROLES_WITH_SCOPE &&
                PartASnapshot.countMembersWithRole(tx, projectId) >= PartASnapshot.MAX_PERSONS
            ) {
                throw ConflictException("Projekt může mít nejvýše ${PartASnapshot.MAX_PERSONS} členů s rolí stavbyvedoucího nebo technického dozoru")
            }

            // A role without a scope has none; otherwise what the request says, and when it says nothing what the member has.
            val scope: String? = when {
                newDbRole !in ROLES_WITH_SCOPE -> null
                scopeGiven == null -> existing?.get(PROJECT_MEMBERS.SCOPE)
                else -> scopeGiven.ifEmpty { null }
            }

            tx.insertInto(PROJECT_MEMBERS)
                .set(PROJECT_MEMBERS.PROJECTID, projectId)
                .set(PROJECT_MEMBERS.USERID, userId)
                .set(PROJECT_MEMBERS.ROLE, newDbRole)
                .set(PROJECT_MEMBERS.SCOPE, scope)
                .set(PROJECT_MEMBERS.ADDEDBYID, actor.id)
                .onConflict(PROJECT_MEMBERS.PROJECTID, PROJECT_MEMBERS.USERID)
                .doUpdate()
                .set(PROJECT_MEMBERS.ROLE, newDbRole)
                .set(PROJECT_MEMBERS.SCOPE, scope)
                .execute()
            AuditService.Audited(
                result = Unit,
                action = "project.member.add",
                entityId = projectId.toString(),
                before = before?.let { memberSnapshot(userId, it.name, existing.get(PROJECT_MEMBERS.SCOPE)) },
                after = memberSnapshot(userId, role.name, scope),
            )
        }
        return listMembers(cz.stavebni.denik.db.DatabaseFactory.dsl, actor, projectId)
    }

    suspend fun removeMember(actor: SessionUser, projectId: UUID, userId: UUID) {
        AuditService.auditedWrite(actor, "project") { tx ->
            val actorRole = ProjectAccess.requireAccess(tx, actor, projectId)
            assertCan(actor, Action.ProjectMemberManage, Resource(role = actorRole))
            val existing = tx.select(PROJECT_MEMBERS.ROLE, PROJECT_MEMBERS.SCOPE).from(PROJECT_MEMBERS)
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId)))
                .forUpdate()
                .fetchOne() ?: throw NotFoundException("Člen projektu nenalezen")
            val before = existing.get(PROJECT_MEMBERS.ROLE)!!
            requireSiteManagerStaysManager(tx, projectId, userId, newRole = null)
            if (before == DbRole.BOSS && !anotherManagerExists(tx, projectId, userId)) {
                throw ConflictException("Projekt musí mít alespoň jednoho aktivního vedoucího (BOSS)")
            }
            tx.deleteFrom(PROJECT_MEMBERS)
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId)))
                .execute()
            AuditService.Audited(
                result = Unit,
                action = "project.member.remove",
                entityId = projectId.toString(),
                before = memberSnapshot(userId, before.name, existing.get(PROJECT_MEMBERS.SCOPE)),
                after = null,
            )
        }
    }
}
