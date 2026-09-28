package cz.stavebni.denik.services

import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.jooq.tables.references.*
import kotlinx.serialization.Serializable
import org.jooq.impl.DSL

@Serializable
data class DashboardStatsDto(
    val activeProjects: Int,
    val pendingUnacknowledgedReports: Int
)

object DashboardService {
    fun getDashboardStats(user: SessionUser): DashboardStatsDto {
        val tx = DatabaseFactory.dsl
        
        val projectsQuery = tx.select(DSL.count())
            .from(PROJECTS)
            
        if (!user.isAdmin) {
            projectsQuery.join(PROJECT_MEMBERS)
                 .on(PROJECTS.ID.eq(PROJECT_MEMBERS.PROJECTID))
                 .where(PROJECT_MEMBERS.USERID.eq(user.id))
        }
        val activeProjects = projectsQuery.fetchOne(0, Int::class.java) ?: 0
        
        val reportsQuery = tx.select(DSL.count())
            .from(DAILY_REPORTS)
            .where(DAILY_REPORTS.ACKNOWLEDGEDBYID.isNull)
            .and(DAILY_REPORTS.SIGNEDBYID.isNotNull)
            
        if (!user.isAdmin) {
            reportsQuery.join(PROJECT_MEMBERS)
                 .on(DAILY_REPORTS.PROJECTID.eq(PROJECT_MEMBERS.PROJECTID))
                 .where(PROJECT_MEMBERS.USERID.eq(user.id))
        }
        val unacknowledgedReports = reportsQuery.fetchOne(0, Int::class.java) ?: 0
        
        return DashboardStatsDto(
            activeProjects = activeProjects,
            pendingUnacknowledgedReports = unacknowledgedReports
        )
    }
}
