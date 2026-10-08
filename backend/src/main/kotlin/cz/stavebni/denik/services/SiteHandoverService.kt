package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.records.SiteHandoversRecord
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import cz.stavebni.denik.services.AuditService.Audited
import cz.stavebni.denik.util.Dates
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import org.jooq.DSLContext
import org.jooq.JSONB
import java.time.OffsetDateTime
import java.util.UUID

@Serializable
data class SiteHandoverDto(
    val id: String? = null,
    val projectId: String,
    val type: String,
    /** YYYY-MM-DD (a full ISO date-time is accepted on input) */
    val date: String,
    val participants: String,
    val meterStates: List<MeterState>? = null,
    val notes: String? = null,
    val createdById: String? = null,
    val signedById: String? = null,
    val signedAt: String? = null
)

/**
 * What the audit log keeps of a handover protocol before and after a change. Text, booleans and whole numbers only (the
 * meter readings stay the JSON *string* that is stored), like the report snapshot.
 */
@Serializable
internal data class HandoverSnapshot(
    val id: String,
    val projectId: String,
    val type: String,
    val date: String,
    val participants: String,
    val meterStates: String?,
    val notes: String?,
    val createdById: String?,
    val signedById: String?,
    val signedAt: String?,
    val deletedAt: String?,
)

/**
 * Site handover protocols. Every write runs through [AuditService.auditedWrite]: the audit lock is taken first, the row is
 * read `FOR UPDATE`, membership and the signed flag are judged inside the transaction, and the update itself refuses a
 * protocol that is signed or deleted. So a protocol cannot be changed or signed twice by two requests that interleave, and
 * a non-member app admin (who may *read* every project) is never treated as a member when writing.
 */
object SiteHandoverService {
    private val json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    private fun toDto(record: SiteHandoversRecord) = SiteHandoverDto(
        id = record.get(SITE_HANDOVERS.ID).toString(),
        projectId = record.get(SITE_HANDOVERS.PROJECTID).toString(),
        type = record.get(SITE_HANDOVERS.TYPE) ?: "",
        date = Dates.format(record.get(SITE_HANDOVERS.DATE)) ?: "",
        participants = record.get(SITE_HANDOVERS.PARTICIPANTS) ?: "",
        meterStates = record.get(SITE_HANDOVERS.METERSTATES)?.data()?.let { json.decodeFromString<List<MeterState>>(it) },
        notes = record.get(SITE_HANDOVERS.NOTES),
        createdById = record.get(SITE_HANDOVERS.CREATEDBYID)?.toString(),
        signedById = record.get(SITE_HANDOVERS.SIGNEDBYID)?.toString(),
        signedAt = record.get(SITE_HANDOVERS.SIGNEDAT)?.toString()
    )

    private fun SiteHandoversRecord.toSnapshot(): JsonElement = json.encodeToJsonElement(
        HandoverSnapshot.serializer(),
        HandoverSnapshot(
            id = get(SITE_HANDOVERS.ID).toString(),
            projectId = get(SITE_HANDOVERS.PROJECTID).toString(),
            type = get(SITE_HANDOVERS.TYPE) ?: "",
            date = Dates.format(get(SITE_HANDOVERS.DATE)) ?: "",
            participants = get(SITE_HANDOVERS.PARTICIPANTS) ?: "",
            meterStates = get(SITE_HANDOVERS.METERSTATES)?.data(),
            notes = get(SITE_HANDOVERS.NOTES),
            createdById = get(SITE_HANDOVERS.CREATEDBYID)?.toString(),
            signedById = get(SITE_HANDOVERS.SIGNEDBYID)?.toString(),
            signedAt = get(SITE_HANDOVERS.SIGNEDAT)?.toString(),
            deletedAt = get(SITE_HANDOVERS.DELETEDAT)?.toString(),
        )
    )

    /** The protocol, read `FOR UPDATE` inside the caller's transaction. */
    private fun lockActive(tx: DSLContext, id: UUID): SiteHandoversRecord =
        tx.selectFrom(SITE_HANDOVERS)
            .where(SITE_HANDOVERS.ID.eq(id).and(SITE_HANDOVERS.DELETEDAT.isNull))
            .forUpdate()
            .fetchOne() ?: throw NotFoundException("Předávací protokol nenalezen")

    suspend fun getHandover(tx: DSLContext, user: SessionUser, handoverId: UUID): SiteHandoverDto? {
        val record = tx.selectFrom(SITE_HANDOVERS)
            .where(SITE_HANDOVERS.ID.eq(handoverId).and(SITE_HANDOVERS.DELETEDAT.isNull))
            .fetchOne() ?: return null
        ProjectAccess.requireAccess(tx, user, record.get(SITE_HANDOVERS.PROJECTID)!!)
        return toDto(record)
    }

    suspend fun listHandovers(tx: DSLContext, user: SessionUser, projectId: UUID): List<SiteHandoverDto> {
        ProjectAccess.requireAccess(tx, user, projectId)
        return tx.selectFrom(SITE_HANDOVERS)
            .where(SITE_HANDOVERS.PROJECTID.eq(projectId).and(SITE_HANDOVERS.DELETEDAT.isNull))
            .orderBy(SITE_HANDOVERS.DATE.desc(), SITE_HANDOVERS.CREATEDAT.desc())
            .fetch()
            .map { toDto(it) }
    }

    suspend fun createHandover(user: SessionUser, dto: SiteHandoverDto): SiteHandoverDto {
        val projectId = ProjectAccess.parseId(dto.projectId, "projectId")
        require(dto.type.isNotBlank()) { "Typ předání je povinný" }
        val date = Dates.parse(dto.date)
        val meterStatesJson = dto.meterStates?.let { JSONB.valueOf(json.encodeToString(it)) }

        return AuditService.auditedWrite(user, "siteHandover") { tx ->
            if (!tx.fetchExists(PROJECTS, PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))) {
                throw NotFoundException("Projekt nenalezen")
            }
            // Real membership: an app admin who is not a member may read the project, not write to it.
            val isMember = ProjectAccess.requireAccess(tx, user, projectId)
            assertCan(user, Action.SiteHandoverCreate, Resource(isMember = isMember))

            val record = tx.insertInto(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.PROJECTID, projectId)
                .set(SITE_HANDOVERS.TYPE, dto.type.trim())
                .set(SITE_HANDOVERS.DATE, date)
                .set(SITE_HANDOVERS.PARTICIPANTS, dto.participants)
                .set(SITE_HANDOVERS.METERSTATES, meterStatesJson)
                .set(SITE_HANDOVERS.NOTES, dto.notes)
                .set(SITE_HANDOVERS.CREATEDBYID, user.id)
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert site handover")

            Audited(
                result = toDto(record),
                action = "siteHandover.create",
                entityId = record.get(SITE_HANDOVERS.ID).toString(),
                after = record.toSnapshot(),
            )
        }
    }

    suspend fun updateHandover(user: SessionUser, id: UUID, dto: SiteHandoverDto): SiteHandoverDto {
        val date = Dates.parse(dto.date)
        val meterStatesJson = dto.meterStates?.let { JSONB.valueOf(json.encodeToString(it)) }

        return AuditService.auditedWrite(user, "siteHandover") { tx ->
            val existing = lockActive(tx, id)
            val isMember = ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
            val isLocked = existing.get(SITE_HANDOVERS.SIGNEDAT) != null
            assertCan(
                user, Action.SiteHandoverUpdate,
                Resource(isMember = isMember, authorId = existing.get(SITE_HANDOVERS.CREATEDBYID), isLocked = isLocked)
            )

            // The row is locked and judged above; the condition on signedAt is the last word if anything slipped through.
            val record = tx.update(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.TYPE, dto.type)
                .set(SITE_HANDOVERS.DATE, date)
                .set(SITE_HANDOVERS.PARTICIPANTS, dto.participants)
                .set(SITE_HANDOVERS.METERSTATES, meterStatesJson)
                .set(SITE_HANDOVERS.NOTES, dto.notes)
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .where(SITE_HANDOVERS.ID.eq(id).and(SITE_HANDOVERS.SIGNEDAT.isNull).and(SITE_HANDOVERS.DELETEDAT.isNull))
                .returning()
                .fetchOne() ?: throw ConflictException("Předávací protokol je podepsán, nelze jej měnit")

            Audited(
                result = toDto(record),
                action = "siteHandover.update",
                entityId = id.toString(),
                before = existing.toSnapshot(),
                after = record.toSnapshot(),
            )
        }
    }

    suspend fun deleteHandover(user: SessionUser, id: UUID) {
        AuditService.auditedWrite(user, "siteHandover") { tx ->
            val existing = lockActive(tx, id)
            val isMember = ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
            val isLocked = existing.get(SITE_HANDOVERS.SIGNEDAT) != null
            assertCan(
                user, Action.SiteHandoverDelete,
                Resource(isMember = isMember, authorId = existing.get(SITE_HANDOVERS.CREATEDBYID), isLocked = isLocked)
            )

            val record = tx.update(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.DELETEDAT, OffsetDateTime.now())
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .where(SITE_HANDOVERS.ID.eq(id).and(SITE_HANDOVERS.SIGNEDAT.isNull).and(SITE_HANDOVERS.DELETEDAT.isNull))
                .returning()
                .fetchOne() ?: throw ConflictException("Předávací protokol je podepsán, nelze jej smazat")

            Audited(
                result = Unit,
                action = "siteHandover.delete",
                entityId = id.toString(),
                before = existing.toSnapshot(),
                after = record.toSnapshot(),
            )
        }
    }

    suspend fun signHandover(user: SessionUser, id: UUID): SiteHandoverDto =
        AuditService.auditedWrite(user, "siteHandover") { tx ->
            val existing = lockActive(tx, id)
            val isMember = ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
            assertCan(user, Action.SiteHandoverSign, Resource(isMember = isMember))
            if (existing.get(SITE_HANDOVERS.SIGNEDAT) != null) {
                throw IllegalStateException("Předávací protokol je již podepsán")
            }

            val record = tx.update(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.SIGNEDBYID, user.id)
                .set(SITE_HANDOVERS.SIGNEDAT, OffsetDateTime.now())
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .where(SITE_HANDOVERS.ID.eq(id).and(SITE_HANDOVERS.SIGNEDAT.isNull).and(SITE_HANDOVERS.DELETEDAT.isNull))
                .returning()
                .fetchOne() ?: throw IllegalStateException("Předávací protokol je již podepsán")

            Audited(
                result = toDto(record),
                action = "siteHandover.sign",
                entityId = id.toString(),
                before = existing.toSnapshot(),
                after = record.toSnapshot(),
            )
        }
}
