package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import org.jooq.DSLContext
import org.jooq.Record
import java.time.OffsetDateTime
import java.util.UUID

/** Persons authorised to make entries in the diary (e.g. designer supervision, TDS, BOZP). */
@Serializable
data class AuthorizedPersonDto(
    val id: String,
    val projectId: String,
    val name: String,
    val company: String? = null,
    val authorization: String? = null,
    val linkedUserId: String? = null,
    val revokedAt: String? = null,
)

@Serializable
data class CreateAuthorizedPersonRequest(
    val name: String,
    val company: String? = null,
    val authorization: String? = null,
    val linkedUserId: String? = null,
)

/** What the audit log keeps of an authorised person (text only). */
@Serializable
internal data class PersonSnapshot(
    val id: String,
    val projectId: String,
    val name: String,
    val company: String?,
    val authorization: String?,
    val linkedUserId: String?,
    val revokedAt: String?,
)

object AuthorizedPersonService {

    fun list(tx: DSLContext, user: SessionUser, projectId: UUID): List<AuthorizedPersonDto> {
        ProjectAccess.requireAccess(tx, user, projectId)
        return tx.selectFrom(AUTHORIZED_PERSONS)
            .where(AUTHORIZED_PERSONS.PROJECTID.eq(projectId))
            .orderBy(AUTHORIZED_PERSONS.CREATEDAT.asc())
            .fetch()
            .map { toDto(it) }
    }

    suspend fun create(actor: SessionUser, projectId: UUID, req: CreateAuthorizedPersonRequest): AuthorizedPersonDto {
        assertCan(actor, Action.ProjectMemberManage)
        val name = req.name.trim()
        require(name.isNotEmpty()) { "Jméno pověřené osoby je povinné" }
        val linkedUserId = req.linkedUserId?.takeIf { it.isNotBlank() }?.let { ProjectAccess.parseId(it, "linkedUserId") }

        return AuditService.auditedWrite(actor, "authorizedPerson") { tx ->
            ProjectAccess.requireAccess(tx, actor, projectId)
            val record = tx.insertInto(AUTHORIZED_PERSONS)
                .set(AUTHORIZED_PERSONS.PROJECTID, projectId)
                .set(AUTHORIZED_PERSONS.NAME, name)
                .set(AUTHORIZED_PERSONS.COMPANY, req.company?.trim()?.ifEmpty { null })
                .set(AUTHORIZED_PERSONS.AUTHORIZATION, req.authorization?.trim()?.ifEmpty { null })
                .set(AUTHORIZED_PERSONS.LINKEDUSERID, linkedUserId)
                .set(AUTHORIZED_PERSONS.UPDATEDAT, OffsetDateTime.now())
                .returning()
                .fetchOne() ?: throw IllegalStateException("Nepodařilo se uložit pověřenou osobu")
            AuditService.Audited(
                result = toDto(record),
                action = "authorizedPerson.create",
                entityId = record.get(AUTHORIZED_PERSONS.ID).toString(),
                after = record.toSnapshot(),
            )
        }
    }

    suspend fun revoke(actor: SessionUser, personId: UUID): AuthorizedPersonDto {
        assertCan(actor, Action.ProjectMemberManage)
        return AuditService.auditedWrite(actor, "authorizedPerson") { tx ->
            val existing = tx.selectFrom(AUTHORIZED_PERSONS)
                .where(AUTHORIZED_PERSONS.ID.eq(personId))
                .forUpdate()
                .fetchOne() ?: throw NotFoundException("Pověřená osoba nenalezena")
            ProjectAccess.requireAccess(tx, actor, existing.get(AUTHORIZED_PERSONS.PROJECTID)!!)
            // Revoking twice must not overwrite the time of the first revocation.
            if (existing.get(AUTHORIZED_PERSONS.REVOKEDAT) != null) throw ConflictException("Pověřená osoba je již odvolána")

            val now = OffsetDateTime.now()
            val record = tx.update(AUTHORIZED_PERSONS)
                .set(AUTHORIZED_PERSONS.REVOKEDAT, now)
                .set(AUTHORIZED_PERSONS.UPDATEDAT, now)
                .where(AUTHORIZED_PERSONS.ID.eq(personId).and(AUTHORIZED_PERSONS.REVOKEDAT.isNull))
                .returning()
                .fetchOne() ?: throw ConflictException("Pověřená osoba je již odvolána")
            AuditService.Audited(
                result = toDto(record),
                action = "authorizedPerson.revoke",
                entityId = personId.toString(),
                before = existing.toSnapshot(),
                after = record.toSnapshot(),
            )
        }
    }

    private fun Record.toSnapshot(): JsonElement = Json.encodeToJsonElement(
        PersonSnapshot.serializer(),
        PersonSnapshot(
            id = get(AUTHORIZED_PERSONS.ID).toString(),
            projectId = get(AUTHORIZED_PERSONS.PROJECTID).toString(),
            name = get(AUTHORIZED_PERSONS.NAME) ?: "",
            company = get(AUTHORIZED_PERSONS.COMPANY),
            authorization = get(AUTHORIZED_PERSONS.AUTHORIZATION),
            linkedUserId = get(AUTHORIZED_PERSONS.LINKEDUSERID)?.toString(),
            revokedAt = get(AUTHORIZED_PERSONS.REVOKEDAT)?.toString(),
        )
    )

    private fun toDto(r: Record) = AuthorizedPersonDto(
        id = r.get(AUTHORIZED_PERSONS.ID).toString(),
        projectId = r.get(AUTHORIZED_PERSONS.PROJECTID).toString(),
        name = r.get(AUTHORIZED_PERSONS.NAME)!!,
        company = r.get(AUTHORIZED_PERSONS.COMPANY),
        authorization = r.get(AUTHORIZED_PERSONS.AUTHORIZATION),
        linkedUserId = r.get(AUTHORIZED_PERSONS.LINKEDUSERID)?.toString(),
        revokedAt = r.get(AUTHORIZED_PERSONS.REVOKEDAT)?.toString(),
    )
}
