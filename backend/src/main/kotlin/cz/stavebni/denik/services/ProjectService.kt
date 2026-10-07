package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.util.Dates
import kotlinx.serialization.Serializable
import org.jooq.DSLContext
import org.jooq.Record
import java.time.OffsetDateTime
import java.util.UUID
import cz.stavebni.denik.jooq.enums.Role as DbRole

@Serializable
data class ProjectDto(
    val id: String = "",
    val name: String,
    val address: String,
    val cadastralArea: String,
    val parcelNumbers: String,
    val builder: String,
    val contractor: String,
    val siteManagerId: String,
    // Legislative / contractual details (vyhláška 499/2006 Sb., příloha 16)
    val permitNumber: String? = null,
    val tdsName: String? = null,
    val bozpName: String? = null,
    val designerName: String? = null,
    val contractNumber: String? = null,
    /** YYYY-MM-DD */
    val contractDate: String? = null,
    val designDocVersion: String? = null,
    /** YYYY-MM-DD */
    val designDocDate: String? = null,
)

object ProjectService {

    fun listProjects(tx: DSLContext, user: SessionUser): List<ProjectDto> {
        val base = tx.select(PROJECTS.asterisk()).from(PROJECTS)
        val records = if (user.isAdmin) {
            base.where(PROJECTS.DELETEDAT.isNull)
                .orderBy(PROJECTS.CREATEDAT.desc())
                .fetch()
        } else {
            base.join(PROJECT_MEMBERS).on(PROJECTS.ID.eq(PROJECT_MEMBERS.PROJECTID))
                .where(PROJECT_MEMBERS.USERID.eq(user.id))
                .and(PROJECTS.DELETEDAT.isNull)
                .orderBy(PROJECTS.CREATEDAT.desc())
                .fetch()
        }
        return records.map { toDto(it) }
    }

    fun getProject(tx: DSLContext, user: SessionUser, projectId: UUID): ProjectDto {
        ProjectAccess.requireAccess(tx, user, projectId)
        val record = tx.select(PROJECTS.asterisk())
            .from(PROJECTS)
            .where(PROJECTS.ID.eq(projectId))
            .fetchOne() ?: throw cz.stavebni.denik.domain.NotFoundException("Projekt nenalezen")
        return toDto(record)
    }

    suspend fun createProject(user: SessionUser, data: ProjectDto): ProjectDto {
        assertCan(user, Action.ProjectCreate)
        val siteManagerId = ProjectAccess.parseId(data.siteManagerId, "siteManagerId")
        require(data.name.isNotBlank()) { "Název zakázky je povinný" }

        return AuditService.auditedTransaction(
            actor = user,
            action = "project.create",
            entityType = "project",
            entityId = ""
        ) { tx ->
            val record = tx.insertInto(PROJECTS)
                .set(PROJECTS.NAME, data.name.trim())
                .set(PROJECTS.ADDRESS, data.address)
                .set(PROJECTS.CADASTRALAREA, data.cadastralArea)
                .set(PROJECTS.PARCELNUMBERS, data.parcelNumbers)
                .set(PROJECTS.BUILDER, data.builder)
                .set(PROJECTS.CONTRACTOR, data.contractor)
                .set(PROJECTS.SITEMANAGERID, siteManagerId)
                .set(PROJECTS.PERMITNUMBER, data.permitNumber.blankToNull())
                .set(PROJECTS.TDSNAME, data.tdsName.blankToNull())
                .set(PROJECTS.BOZPNAME, data.bozpName.blankToNull())
                .set(PROJECTS.DESIGNERNAME, data.designerName.blankToNull())
                .set(PROJECTS.CONTRACTNUMBER, data.contractNumber.blankToNull())
                .set(PROJECTS.CONTRACTDATE, Dates.parseOrNull(data.contractDate))
                .set(PROJECTS.DESIGNDOCVERSION, data.designDocVersion.blankToNull())
                .set(PROJECTS.DESIGNDOCDATE, Dates.parseOrNull(data.designDocDate))
                .set(PROJECTS.CREATEDBYID, user.id)
                .set(PROJECTS.UPDATEDAT, OffsetDateTime.now())
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert project")

            val projectId = record.get(PROJECTS.ID)!!

            // The creator and the site manager become project members.
            tx.insertInto(PROJECT_MEMBERS)
                .set(PROJECT_MEMBERS.PROJECTID, projectId)
                .set(PROJECT_MEMBERS.USERID, user.id)
                .set(PROJECT_MEMBERS.ROLE, DbRole.valueOf(user.role.name))
                .set(PROJECT_MEMBERS.ADDEDBYID, user.id)
                .onConflictDoNothing()
                .execute()

            if (siteManagerId != user.id) {
                val managerRole = tx.select(USERS.ROLE).from(USERS)
                    .where(USERS.ID.eq(siteManagerId))
                    .fetchOne()?.value1() ?: DbRole.BOSS
                tx.insertInto(PROJECT_MEMBERS)
                    .set(PROJECT_MEMBERS.PROJECTID, projectId)
                    .set(PROJECT_MEMBERS.USERID, siteManagerId)
                    .set(PROJECT_MEMBERS.ROLE, managerRole)
                    .set(PROJECT_MEMBERS.ADDEDBYID, user.id)
                    .onConflictDoNothing()
                    .execute()
            }

            toDto(record)
        }
    }

    private fun String?.blankToNull(): String? = this?.trim()?.ifEmpty { null }

    private fun toDto(r: Record): ProjectDto = ProjectDto(
        id = r.get(PROJECTS.ID).toString(),
        name = r.get(PROJECTS.NAME)!!,
        address = r.get(PROJECTS.ADDRESS)!!,
        cadastralArea = r.get(PROJECTS.CADASTRALAREA)!!,
        parcelNumbers = r.get(PROJECTS.PARCELNUMBERS)!!,
        builder = r.get(PROJECTS.BUILDER)!!,
        contractor = r.get(PROJECTS.CONTRACTOR)!!,
        siteManagerId = r.get(PROJECTS.SITEMANAGERID).toString(),
        permitNumber = r.get(PROJECTS.PERMITNUMBER),
        tdsName = r.get(PROJECTS.TDSNAME),
        bozpName = r.get(PROJECTS.BOZPNAME),
        designerName = r.get(PROJECTS.DESIGNERNAME),
        contractNumber = r.get(PROJECTS.CONTRACTNUMBER),
        contractDate = Dates.format(r.get(PROJECTS.CONTRACTDATE)),
        designDocVersion = r.get(PROJECTS.DESIGNDOCVERSION),
        designDocDate = Dates.format(r.get(PROJECTS.DESIGNDOCDATE)),
    )
}
