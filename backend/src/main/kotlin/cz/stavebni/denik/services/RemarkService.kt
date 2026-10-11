package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.enums.Remarktype
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.REMARKS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.services.AuditService.Audited
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jooq.DSLContext
import java.util.UUID

/** An entry of another party as the API shows it. */
@Serializable
data class RemarkDto(
    val id: String,
    val reportId: String,
    val authorId: String,
    val authorName: String,
    /** INSPECTOR_REMARK (technical or author's supervision, ...), INVESTOR_NOTE (the client) or EXTERNAL_ENTRY (an outside party, recorded by the manager). */
    val type: String,
    val text: String,
    /** The outside party an EXTERNAL_ENTRY speaks for (an authority, a person without an account); null otherwise. */
    val externalAuthor: String? = null,
    val createdAt: String,
)

@Serializable
data class CreateRemarkRequest(val text: String = "", val externalAuthor: String? = null)

/** What the audit log keeps of an entry: the whole of it (it can never change). */
@Serializable
internal data class RemarkSnapshot(
    val id: String,
    val reportId: String,
    val projectId: String,
    val authorId: String,
    val type: String,
    val text: String,
    val externalAuthor: String? = null,
)

/**
 * Entries of other parties in the diary: the technical supervision, the author's supervision, the client and the
 * authorities write their own entries, **also after the day's entry was signed**. They are never edited or removed
 * (append-only in the database, migration V10).
 *
 * - A member with the role INSPECTOR or INVESTOR in the project writes in their own name.
 * - An authority or a person without an account does not write: the project's manager (BOSS) records the entry for them
 *   and **names them** (decision D9); the entry says who recorded it and for whom.
 * - A worker does not make such entries: the daily entry is their place.
 */
object RemarkService {

    const val MAX_LENGTH = 4000
    const val MAX_AUTHOR_LENGTH = 200

    fun list(tx: DSLContext, user: SessionUser, reportId: UUID): List<RemarkDto> {
        ProjectAccess.requireReportAccess(tx, user, reportId)
        return tx.select(REMARKS.ID, REMARKS.REPORTID, REMARKS.AUTHORID, USERS.DISPLAYNAME, REMARKS.TYPE, REMARKS.TEXT, REMARKS.EXTERNALAUTHOR, REMARKS.CREATEDAT)
            .from(REMARKS)
            .join(USERS).on(USERS.ID.eq(REMARKS.AUTHORID))
            .where(REMARKS.REPORTID.eq(reportId))
            .orderBy(REMARKS.CREATEDAT.asc(), REMARKS.ID.asc())
            .fetch()
            .map { r ->
                RemarkDto(
                    id = r.get(REMARKS.ID).toString(),
                    reportId = r.get(REMARKS.REPORTID).toString(),
                    authorId = r.get(REMARKS.AUTHORID).toString(),
                    authorName = r.get(USERS.DISPLAYNAME) ?: "",
                    type = r.get(REMARKS.TYPE)!!.name,
                    text = r.get(REMARKS.TEXT) ?: "",
                    externalAuthor = r.get(REMARKS.EXTERNALAUTHOR),
                    createdAt = r.get(REMARKS.CREATEDAT).toString(),
                )
            }
    }

    suspend fun create(user: SessionUser, reportId: UUID, request: CreateRemarkRequest): RemarkDto {
        val text = request.text.trim()
        require(text.isNotEmpty()) { "Zápis nesmí být prázdný" }
        require(text.length <= MAX_LENGTH) { "Zápis je příliš dlouhý (nejvýše $MAX_LENGTH znaků)" }
        val externalAuthor = request.externalAuthor?.trim()?.takeIf { it.isNotEmpty() }
        require(externalAuthor == null || externalAuthor.length <= MAX_AUTHOR_LENGTH) { "Jméno autora je příliš dlouhé (nejvýše $MAX_AUTHOR_LENGTH znaků)" }

        return AuditService.auditedWrite(user, "report") { tx ->
            val report = tx.selectFrom(DAILY_REPORTS)
                .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
                .fetchOne() ?: throw NotFoundException("Záznam nenalezen")
            val projectId = report.projectid!!
            // Real membership and the role in THIS project: an administrator who is not a member may read, not write.
            val role = ProjectAccess.roleIn(tx, user.id, projectId)
            assertCan(user, Action.RemarkCreate, Resource(role = role))

            val type = when (role) {
                Role.INSPECTOR -> {
                    require(externalAuthor == null) { "Za jinou osobu zapisuje vedoucí projektu" }
                    Remarktype.INSPECTOR_REMARK
                }
                Role.INVESTOR -> {
                    require(externalAuthor == null) { "Za jinou osobu zapisuje vedoucí projektu" }
                    Remarktype.INVESTOR_NOTE
                }
                // The manager's own words belong in the daily entry; here they record what an outside party said.
                else -> {
                    require(externalAuthor != null) { "Uveďte, za koho zápis pořizujete (orgán, osoba bez účtu)" }
                    Remarktype.EXTERNAL_ENTRY
                }
            }

            val record = tx.insertInto(REMARKS)
                .set(REMARKS.REPORTID, reportId)
                .set(REMARKS.AUTHORID, user.id)
                .set(REMARKS.TYPE, type)
                .set(REMARKS.TEXT, text)
                .set(REMARKS.ISOFFICIAL, type == Remarktype.EXTERNAL_ENTRY)
                .set(REMARKS.EXTERNALAUTHOR, externalAuthor)
                .returning()
                .fetchOne() ?: throw IllegalStateException("Zápis se nepodařilo uložit")

            val dto = RemarkDto(
                id = record.get(REMARKS.ID).toString(),
                reportId = reportId.toString(),
                authorId = user.id.toString(),
                authorName = user.displayName,
                type = type.name,
                text = text,
                externalAuthor = externalAuthor,
                createdAt = record.get(REMARKS.CREATEDAT).toString(),
            )
            Audited(
                result = dto,
                action = "report.remark.add",
                entityId = reportId.toString(),
                after = Json.encodeToJsonElement(
                    RemarkSnapshot.serializer(),
                    RemarkSnapshot(dto.id, reportId.toString(), projectId.toString(), user.id.toString(), type.name, text, externalAuthor),
                ),
            )
        }
    }
}
