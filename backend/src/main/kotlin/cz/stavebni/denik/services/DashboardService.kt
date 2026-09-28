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
        
        val activeProjects = if (!user.isAdmin) {
            tx.select(DSL.count())
                .from(PROJECTS)
                .join(PROJECT_MEMBERS)
                .on(PROJECTS.ID.eq(PROJECT_MEMBERS.PROJECTID))
                .where(PROJECT_MEMBERS.USERID.eq(user.id))
                .fetchOne(0, Int::class.java) ?: 0
        } else {
            tx.select(DSL.count())
                .from(PROJECTS)
                .fetchOne(0, Int::class.java) ?: 0
        }
        
        val unacknowledgedReports = if (!user.isAdmin) {
            tx.select(DSL.count())
                .from(DAILY_REPORTS)
                .join(PROJECT_MEMBERS)
                .on(DAILY_REPORTS.PROJECTID.eq(PROJECT_MEMBERS.PROJECTID))
                .where(PROJECT_MEMBERS.USERID.eq(user.id))
                .and(DAILY_REPORTS.ACKNOWLEDGEDBYID.isNull)
                .and(DAILY_REPORTS.SIGNEDBYID.isNotNull)
                .fetchOne(0, Int::class.java) ?: 0
        } else {
            tx.select(DSL.count())
                .from(DAILY_REPORTS)
                .where(DAILY_REPORTS.ACKNOWLEDGEDBYID.isNull)
                .and(DAILY_REPORTS.SIGNEDBYID.isNotNull)
                .fetchOne(0, Int::class.java) ?: 0
        }
        
        return DashboardStatsDto(
            activeProjects = activeProjects,
            pendingUnacknowledgedReports = unacknowledgedReports
        )
    }
}
