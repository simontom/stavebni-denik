package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.ADDENDA
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.services.AuditService.Audited
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jooq.DSLContext
import java.util.UUID

/** One addendum as the API shows it. */
@Serializable
data class AddendumDto(
    val id: String,
    val reportId: String,
    val authorId: String,
    val authorName: String,
    val text: String,
    val createdAt: String,
)

@Serializable
data class CreateAddendumRequest(val text: String = "")

/** What the audit log keeps of an addendum: the whole of it (it can never change). */
@Serializable
internal data class AddendumSnapshot(val id: String, val reportId: String, val projectId: String, val authorId: String, val text: String)

/**
 * Addenda (dodatky): how a **signed** daily entry is corrected or completed. The entry itself can no longer be changed,
 * so a mistake or a missing remark stands next to it as a new, dated, attributed record that can never be edited or
 * removed (the table is append-only in the database, migration V9). An entry that is still being written is simply
 * edited: an addendum to it is refused.
 *
 * An addendum is not part of what the signature covers (it comes after it); it is covered by the audit log, whose row
 * holds the whole text.
 */
object AddendumService {

    const val MAX_LENGTH = 4000

    fun list(tx: DSLContext, user: SessionUser, reportId: UUID): List<AddendumDto> {
        ProjectAccess.requireReportAccess(tx, user, reportId)
        return tx.select(ADDENDA.ID, ADDENDA.REPORTID, ADDENDA.AUTHORID, USERS.DISPLAYNAME, ADDENDA.TEXT, ADDENDA.CREATEDAT)
            .from(ADDENDA)
            .join(USERS).on(USERS.ID.eq(ADDENDA.AUTHORID))
            .where(ADDENDA.REPORTID.eq(reportId))
            .orderBy(ADDENDA.CREATEDAT.asc(), ADDENDA.ID.asc())
            .fetch()
            .map { r ->
                AddendumDto(
                    id = r.get(ADDENDA.ID).toString(),
                    reportId = r.get(ADDENDA.REPORTID).toString(),
                    authorId = r.get(ADDENDA.AUTHORID).toString(),
                    authorName = r.get(USERS.DISPLAYNAME) ?: "",
                    text = r.get(ADDENDA.TEXT) ?: "",
                    createdAt = r.get(ADDENDA.CREATEDAT).toString(),
                )
            }
    }

    suspend fun create(user: SessionUser, reportId: UUID, request: CreateAddendumRequest): AddendumDto {
        val text = request.text.trim()
        require(text.isNotEmpty()) { "Dodatek nesmí být prázdný" }
        require(text.length <= MAX_LENGTH) { "Dodatek je příliš dlouhý (nejvýše $MAX_LENGTH znaků)" }

        return AuditService.auditedWrite(user, "report") { tx ->
            // The entry is locked FOR UPDATE: it cannot be signed, deleted or changed while the addendum is being decided on.
            val report = tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
                .forUpdate()
                .fetchOne() ?: throw NotFoundException("Záznam nenalezen")
            val projectId = report.projectid!!
            // Real membership and the role in this project: an administrator who is not a member may read, not write.
            val role = ProjectAccess.roleIn(tx, user.id, projectId)
            assertCan(user, Action.ReportAddendumCreate, Resource(role = role))
            if (report.lockedat == null) {
                throw ConflictException("Dodatek lze přidat jen k podepsanému záznamu. Nepodepsaný záznam se upravuje přímo.")
            }

            val record = tx.insertInto(ADDENDA)
                .set(ADDENDA.REPORTID, reportId)
                .set(ADDENDA.AUTHORID, user.id)
                .set(ADDENDA.TEXT, text)
                .returning()
                .fetchOne() ?: throw IllegalStateException("Dodatek se nepodařilo uložit")

            val dto = AddendumDto(
                id = record.get(ADDENDA.ID).toString(),
                reportId = reportId.toString(),
                authorId = user.id.toString(),
                authorName = user.displayName,
                text = text,
                createdAt = record.get(ADDENDA.CREATEDAT).toString(),
            )
            Audited(
                result = dto,
                action = "report.addendum.add",
                entityId = reportId.toString(),
                after = Json.encodeToJsonElement(
                    AddendumSnapshot.serializer(),
                    AddendumSnapshot(dto.id, reportId.toString(), projectId.toString(), user.id.toString(), text),
                ),
            )
        }
    }
}
