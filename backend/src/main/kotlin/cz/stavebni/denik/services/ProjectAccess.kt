package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import org.jooq.DSLContext
import java.util.UUID

/**
 * Project-level access control shared by all project-scoped routes.
 *
 * App admins can open every project; everybody else has to be a project member.
 */
object ProjectAccess {

    fun isMember(tx: DSLContext, userId: UUID, projectId: UUID): Boolean =
        tx.fetchExists(
            PROJECT_MEMBERS,
            PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(userId))
        )

    /**
     * Ensures the project exists (and is not soft-deleted) and that [user] may open it.
     *
     * @return true when the user acts as a project member (members, and admins
     *   who are treated as members for RBAC purposes).
     */
    fun requireAccess(tx: DSLContext, user: SessionUser, projectId: UUID): Boolean {
        val exists = tx.fetchExists(PROJECTS, PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))
        if (!exists) throw NotFoundException("Projekt nenalezen")
        val member = isMember(tx, user.id, projectId)
        if (!member && !user.isAdmin) throw ForbiddenException(Action.ProjectListAll)
        return true
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
