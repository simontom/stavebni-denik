package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.records.SiteHandoversRecord
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import cz.stavebni.denik.util.Dates
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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

    private fun findActive(tx: DSLContext, id: UUID): SiteHandoversRecord =
        tx.selectFrom(SITE_HANDOVERS)
            .where(SITE_HANDOVERS.ID.eq(id).and(SITE_HANDOVERS.DELETEDAT.isNull))
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
        ProjectAccess.requireAccess(DatabaseFactory.dsl, user, projectId)
        assertCan(user, Action.SiteHandoverCreate, Resource(isMember = true))
        require(dto.type.isNotBlank()) { "Typ předání je povinný" }
        val date = Dates.parse(dto.date)

        return AuditService.auditedTransaction(
            actor = user,
            action = "siteHandover.create",
            entityType = "siteHandover",
            entityId = ""
        ) { tx ->
            val meterStatesJson = dto.meterStates?.let { JSONB.valueOf(json.encodeToString(it)) }

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

            toDto(record)
        }
    }

    suspend fun updateHandover(user: SessionUser, id: UUID, dto: SiteHandoverDto): SiteHandoverDto {
        val tx = DatabaseFactory.dsl
        val existing = findActive(tx, id)
        ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
        val isLocked = existing.get(SITE_HANDOVERS.SIGNEDAT) != null
        assertCan(user, Action.SiteHandoverUpdate, Resource(isMember = true, authorId = existing.get(SITE_HANDOVERS.CREATEDBYID), isLocked = isLocked))
        val date = Dates.parse(dto.date)

        return AuditService.auditedTransaction(
            actor = user,
            action = "siteHandover.update",
            entityType = "siteHandover",
            entityId = id.toString()
        ) { t ->
            val meterStatesJson = dto.meterStates?.let { JSONB.valueOf(json.encodeToString(it)) }

            val record = t.update(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.TYPE, dto.type)
                .set(SITE_HANDOVERS.DATE, date)
                .set(SITE_HANDOVERS.PARTICIPANTS, dto.participants)
                .set(SITE_HANDOVERS.METERSTATES, meterStatesJson)
                .set(SITE_HANDOVERS.NOTES, dto.notes)
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .where(SITE_HANDOVERS.ID.eq(id))
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to update site handover")

            toDto(record)
        }
    }

    suspend fun deleteHandover(user: SessionUser, id: UUID) {
        val tx = DatabaseFactory.dsl
        val existing = findActive(tx, id)
        ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
        val isLocked = existing.get(SITE_HANDOVERS.SIGNEDAT) != null
        assertCan(user, Action.SiteHandoverDelete, Resource(isMember = true, authorId = existing.get(SITE_HANDOVERS.CREATEDBYID), isLocked = isLocked))

        AuditService.auditedTransaction(
            actor = user,
            action = "siteHandover.delete",
            entityType = "siteHandover",
            entityId = id.toString()
        ) { t ->
            t.update(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.DELETEDAT, OffsetDateTime.now())
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .where(SITE_HANDOVERS.ID.eq(id))
                .execute()
        }
    }

    suspend fun signHandover(user: SessionUser, id: UUID): SiteHandoverDto {
        val tx = DatabaseFactory.dsl
        val existing = findActive(tx, id)
        ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
        assertCan(user, Action.SiteHandoverSign, Resource(isMember = true))
        if (existing.get(SITE_HANDOVERS.SIGNEDAT) != null) {
            throw IllegalStateException("Předávací protokol je již podepsán")
        }

        return AuditService.auditedTransaction(
            actor = user,
            action = "siteHandover.sign",
            entityType = "siteHandover",
            entityId = id.toString()
        ) { t ->
            val record = t.update(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.SIGNEDBYID, user.id)
                .set(SITE_HANDOVERS.SIGNEDAT, OffsetDateTime.now())
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .where(SITE_HANDOVERS.ID.eq(id))
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to sign site handover")

            toDto(record)
        }
    }
}
