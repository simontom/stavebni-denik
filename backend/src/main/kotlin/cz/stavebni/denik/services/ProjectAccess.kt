package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import org.jooq.DSLContext
import java.util.UUID

/**
 * Project-level access control shared by all project-scoped routes.
 *
 * App admins can open every project; everybody else has to be a project member. What a member may do follows the
 * role they hold **in that project** (see [roleIn]), not their global role.
 */
object ProjectAccess {

    /** The role [userId] holds in the project, or null when they are not a member. */
    fun roleIn(tx: DSLContext, userId: UUID, projectId: UUID): Role? =
        tx.select(PROJECT_MEMBERS.ROLE)
            .from(PROJECT_MEMBERS)
            .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId)))
            .fetchOne(PROJECT_MEMBERS.ROLE)
            ?.let { Role.valueOf(it.name) }

    fun isMember(tx: DSLContext, userId: UUID, projectId: UUID): Boolean = roleIn(tx, userId, projectId) != null

    /**
     * Ensures the project exists (and is not soft-deleted) and that [user] may open it.
     *
     * @return the role the user holds in the project, or null for an app admin who is not a member:
     *   such a person may read the project but must not be treated as a member when deciding about writes. Pass
     *   this value, not a guess, to [cz.stavebni.denik.domain.Resource].
     */
    fun requireAccess(tx: DSLContext, user: SessionUser, projectId: UUID): Role? {
        val exists = tx.fetchExists(PROJECTS, PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))
        if (!exists) throw NotFoundException("Projekt nenalezen")
        val role = roleIn(tx, user.id, projectId)
        if (role == null && !user.isAdmin) throw ForbiddenException(Action.ProjectListAll)
        return role
    }

    /** Resolves the project of a report and checks access to it. */
    fun requireReportAccess(tx: DSLContext, user: SessionUser, reportId: UUID): UUID {
        val projectId = tx.select(DAILY_REPORTS.PROJECTID)
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .fetchOne()
            ?.value1()
            ?: throw NotFoundException("Záznam nenalezen")
        requireAccess(tx, user, projectId)
        return projectId
    }

    fun parseId(value: String?, what: String = "id"): UUID {
        if (value.isNullOrBlank()) throw IllegalArgumentException("Chybí $what")
        return try {
            UUID.fromString(value)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("Neplatné $what: $value")
        }
    }
}
