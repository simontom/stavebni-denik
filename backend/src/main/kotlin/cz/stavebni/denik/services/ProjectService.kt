package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.StaleVersionException
import cz.stavebni.denik.util.Dates
import cz.stavebni.denik.util.Text
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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
    // Legislative / contractual details (vyhláška 131/2024 Sb., příloha 12, part A; see PROJECT.md "What an entry says")
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
    /** The date of the permit (the number is [permitNumber]); YYYY-MM-DD. */
    val permitDate: String? = null,
    /** The firms of the subcontractors, one per line. */
    val subcontractors: String? = null,
    /** The documents the diary refers to (contracts, permits, consents, decisions, protocols), one per line. */
    val supportingDocuments: String? = null,
    /**
     * When the project was last changed (ISO-8601), set by the server. A client that edits the project sends back the value
     * it saw: the save is refused (409) when somebody else changed the project in between.
     */
    val updatedAt: String? = null,
    /** The role the requesting user holds in this project (BOSS, WORKER, INSPECTOR, INVESTOR); null for an administrator who is not a member. Set by the server, ignored in requests. */
    val myRole: String? = null,
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
        val roles = rolesOf(tx, user.id)
        return records.map { toDto(it, roles[it.get(PROJECTS.ID)]) }
    }

    /** The role of [userId] in every project they are a member of. */
    private fun rolesOf(tx: DSLContext, userId: UUID): Map<UUID, DbRole> =
        tx.select(PROJECT_MEMBERS.PROJECTID, PROJECT_MEMBERS.ROLE)
            .from(PROJECT_MEMBERS)
            .where(PROJECT_MEMBERS.USERID.eq(userId))
            .fetch()
            .associate { it.get(PROJECT_MEMBERS.PROJECTID)!! to it.get(PROJECT_MEMBERS.ROLE)!! }

    fun getProject(tx: DSLContext, user: SessionUser, projectId: UUID): ProjectDto {
        val role = ProjectAccess.requireAccess(tx, user, projectId)
        val record = tx.select(PROJECTS.asterisk())
            .from(PROJECTS)
            .where(PROJECTS.ID.eq(projectId))
            .fetchOne() ?: throw cz.stavebni.denik.domain.NotFoundException("Projekt nenalezen")
        return toDto(record, role?.let { DbRole.valueOf(it.name) })
    }

    /** What a project holds that a person enters, validated and trimmed. Anything wrong is a 400 with a message. */
    private class Fields(
        val name: String, val address: String, val cadastralArea: String, val parcelNumbers: String,
        val builder: String, val contractor: String,
        val permitNumber: String?, val permitDate: OffsetDateTime?, val tdsName: String?, val bozpName: String?,
        val designerName: String?, val contractNumber: String?, val contractDate: OffsetDateTime?,
        val designDocVersion: String?, val designDocDate: OffsetDateTime?,
        val subcontractors: String?, val supportingDocuments: String?,
    )

    private const val MAX_NAME_CHARS = 200
    private const val MAX_LONG_CHARS = 500
    private const val MAX_LIST_CHARS = 5_000

    private fun validated(data: ProjectDto): Fields {
        fun required(value: String, what: String, max: Int): String {
            val text = value.trim()
            require(text.isNotEmpty()) { "$what je povinný údaj" }
            return Text.checked(text, what, max)
        }
        fun optional(value: String?, what: String, max: Int): String? = value?.trim()?.ifEmpty { null }?.let { Text.checked(it, what, max) }
        return Fields(
            name = required(data.name, "Název stavby", MAX_NAME_CHARS),
            address = required(data.address, "Adresa", MAX_LONG_CHARS),
            cadastralArea = required(data.cadastralArea, "Katastrální území", MAX_NAME_CHARS),
            parcelNumbers = required(data.parcelNumbers, "Parcelní čísla", MAX_LONG_CHARS),
            builder = required(data.builder, "Stavebník", MAX_LONG_CHARS),
            contractor = required(data.contractor, "Zhotovitel", MAX_LONG_CHARS),
            permitNumber = optional(data.permitNumber, "Číslo povolení", MAX_NAME_CHARS),
            permitDate = Dates.parseOrNull(data.permitDate),
            tdsName = optional(data.tdsName, "Technický dozor stavebníka", MAX_NAME_CHARS),
            bozpName = optional(data.bozpName, "Koordinátor BOZP", MAX_NAME_CHARS),
            designerName = optional(data.designerName, "Projektant", MAX_LONG_CHARS),
            contractNumber = optional(data.contractNumber, "Číslo smlouvy", MAX_NAME_CHARS),
            contractDate = Dates.parseOrNull(data.contractDate),
            designDocVersion = optional(data.designDocVersion, "Verze projektové dokumentace", MAX_NAME_CHARS),
            designDocDate = Dates.parseOrNull(data.designDocDate),
            subcontractors = optional(data.subcontractors, "Poddodavatelé", MAX_LIST_CHARS),
            supportingDocuments = optional(data.supportingDocuments, "Podklady", MAX_LIST_CHARS),
        )
    }

    /** What the audit row of a project keeps: everything a person can enter, as text. */
    @Serializable
    internal data class ProjectSnapshot(
        val id: String, val name: String, val address: String, val cadastralArea: String, val parcelNumbers: String,
        val builder: String, val contractor: String, val siteManagerId: String,
        val permitNumber: String?, val permitDate: String?, val tdsName: String?, val bozpName: String?, val designerName: String?,
        val contractNumber: String?, val contractDate: String?, val designDocVersion: String?, val designDocDate: String?,
        val subcontractors: String?, val supportingDocuments: String?,
    )

    private fun snapshot(r: Record): JsonElement = Json.encodeToJsonElement(
        ProjectSnapshot.serializer(),
        ProjectSnapshot(
            id = r.get(PROJECTS.ID).toString(), name = r.get(PROJECTS.NAME)!!, address = r.get(PROJECTS.ADDRESS)!!,
            cadastralArea = r.get(PROJECTS.CADASTRALAREA)!!, parcelNumbers = r.get(PROJECTS.PARCELNUMBERS)!!,
            builder = r.get(PROJECTS.BUILDER)!!, contractor = r.get(PROJECTS.CONTRACTOR)!!,
            siteManagerId = r.get(PROJECTS.SITEMANAGERID).toString(),
            permitNumber = r.get(PROJECTS.PERMITNUMBER), permitDate = Dates.format(r.get(PROJECTS.PERMITDATE)),
            tdsName = r.get(PROJECTS.TDSNAME), bozpName = r.get(PROJECTS.BOZPNAME), designerName = r.get(PROJECTS.DESIGNERNAME),
            contractNumber = r.get(PROJECTS.CONTRACTNUMBER), contractDate = Dates.format(r.get(PROJECTS.CONTRACTDATE)),
            designDocVersion = r.get(PROJECTS.DESIGNDOCVERSION), designDocDate = Dates.format(r.get(PROJECTS.DESIGNDOCDATE)),
            subcontractors = r.get(PROJECTS.SUBCONTRACTORS), supportingDocuments = r.get(PROJECTS.SUPPORTINGDOCUMENTS),
        ),
    )

    suspend fun createProject(user: SessionUser, data: ProjectDto): ProjectDto {
        assertCan(user, Action.ProjectCreate)
        val siteManagerId = ProjectAccess.parseId(data.siteManagerId, "siteManagerId")
        val fields = validated(data)

        return AuditService.auditedWrite(user, "project") { tx ->
            // The site manager signs the diary and the creator becomes a manager of the project: both hold a ČKAIT number (decision D2).
            if (!ProjectAccess.hasCkaitNumber(tx, siteManagerId)) {
                throw IllegalArgumentException("Stavbyvedoucí musí mít číslo ČKAIT. Doplňte ho nejdřív u uživatele.")
            }
            if (!ProjectAccess.hasCkaitNumber(tx, user.id)) {
                throw IllegalArgumentException("Zakladatel projektu se stává jeho vedoucím a musí mít číslo ČKAIT. Požádejte administrátora, aby je doplnil u vašeho účtu.")
            }
            val record = tx.insertInto(PROJECTS)
                .set(PROJECTS.NAME, fields.name)
                .set(PROJECTS.ADDRESS, fields.address)
                .set(PROJECTS.CADASTRALAREA, fields.cadastralArea)
                .set(PROJECTS.PARCELNUMBERS, fields.parcelNumbers)
                .set(PROJECTS.BUILDER, fields.builder)
                .set(PROJECTS.CONTRACTOR, fields.contractor)
                .set(PROJECTS.SITEMANAGERID, siteManagerId)
                .set(PROJECTS.PERMITNUMBER, fields.permitNumber)
                .set(PROJECTS.PERMITDATE, fields.permitDate)
                .set(PROJECTS.TDSNAME, fields.tdsName)
                .set(PROJECTS.BOZPNAME, fields.bozpName)
                .set(PROJECTS.DESIGNERNAME, fields.designerName)
                .set(PROJECTS.CONTRACTNUMBER, fields.contractNumber)
                .set(PROJECTS.CONTRACTDATE, fields.contractDate)
                .set(PROJECTS.DESIGNDOCVERSION, fields.designDocVersion)
                .set(PROJECTS.DESIGNDOCDATE, fields.designDocDate)
                .set(PROJECTS.SUBCONTRACTORS, fields.subcontractors)
                .set(PROJECTS.SUPPORTINGDOCUMENTS, fields.supportingDocuments)
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

            // The creator is a manager of the project they create (creating one needs the global role BOSS). The audit row
            // names the project and keeps what was entered.
            AuditService.Audited(
                result = toDto(record, DbRole.valueOf(user.role.name)),
                action = "project.create",
                entityId = projectId.toString(),
                after = snapshot(record),
            )
        }
    }

    /**
     * Changes what is entered about a project (the identification of the diary). Only the manager of the project may, with
     * the role held in THIS project: an administrator who is not a member has no implicit right (decision D1). The site
     * manager is not changed here. The audit row keeps the project as it was and as it is. [data] carries the `updatedAt` the
     * client saw: when somebody else changed the project since, the save is refused (409) instead of overwriting them.
     */
    suspend fun updateProject(user: SessionUser, projectId: UUID, data: ProjectDto): ProjectDto {
        val fields = validated(data)
        val expected = data.updatedAt?.takeIf { it.isNotBlank() }?.let {
            try {
                OffsetDateTime.parse(it)
            } catch (e: java.time.format.DateTimeParseException) {
                throw IllegalArgumentException("Neplatná hodnota updatedAt")
            }
        }
        val requestedManager = data.siteManagerId.takeIf { it.isNotBlank() }?.let { ProjectAccess.parseId(it, "siteManagerId") }

        return AuditService.auditedWrite(user, "project") { tx ->
            val role = ProjectAccess.requireAccess(tx, user, projectId)
            assertCan(user, Action.ProjectUpdate, Resource(role = role))
            val existing = tx.selectFrom(PROJECTS)
                .where(PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))
                .forUpdate()
                .fetchOne() ?: throw cz.stavebni.denik.domain.NotFoundException("Projekt nenalezen")
            if (requestedManager != null && requestedManager != existing.sitemanagerid) {
                throw ConflictException("Stavbyvedoucího nelze touto úpravou změnit")
            }
            if (expected != null && !existing.updatedat!!.isEqual(expected)) {
                throw StaleVersionException("Údaje o stavbě mezitím změnil někdo jiný. Načtěte je znovu, aby se jeho změny neztratily.")
            }
            val updated = tx.update(PROJECTS)
                .set(PROJECTS.NAME, fields.name)
                .set(PROJECTS.ADDRESS, fields.address)
                .set(PROJECTS.CADASTRALAREA, fields.cadastralArea)
                .set(PROJECTS.PARCELNUMBERS, fields.parcelNumbers)
                .set(PROJECTS.BUILDER, fields.builder)
                .set(PROJECTS.CONTRACTOR, fields.contractor)
                .set(PROJECTS.PERMITNUMBER, fields.permitNumber)
                .set(PROJECTS.PERMITDATE, fields.permitDate)
                .set(PROJECTS.TDSNAME, fields.tdsName)
                .set(PROJECTS.BOZPNAME, fields.bozpName)
                .set(PROJECTS.DESIGNERNAME, fields.designerName)
                .set(PROJECTS.CONTRACTNUMBER, fields.contractNumber)
                .set(PROJECTS.CONTRACTDATE, fields.contractDate)
                .set(PROJECTS.DESIGNDOCVERSION, fields.designDocVersion)
                .set(PROJECTS.DESIGNDOCDATE, fields.designDocDate)
                .set(PROJECTS.SUBCONTRACTORS, fields.subcontractors)
                .set(PROJECTS.SUPPORTINGDOCUMENTS, fields.supportingDocuments)
                .set(PROJECTS.UPDATEDAT, OffsetDateTime.now())
                .where(PROJECTS.ID.eq(projectId))
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to update project")
            AuditService.Audited(
                result = toDto(updated, role?.let { DbRole.valueOf(it.name) }),
                action = "project.update",
                entityId = projectId.toString(),
                before = snapshot(existing),
                after = snapshot(updated),
            )
        }
    }

    private fun toDto(r: Record, myRole: DbRole?): ProjectDto = ProjectDto(
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
        permitDate = Dates.format(r.get(PROJECTS.PERMITDATE)),
        subcontractors = r.get(PROJECTS.SUBCONTRACTORS),
        supportingDocuments = r.get(PROJECTS.SUPPORTINGDOCUMENTS),
        updatedAt = r.get(PROJECTS.UPDATEDAT)?.toString(),
        myRole = myRole?.name,
    )
}
