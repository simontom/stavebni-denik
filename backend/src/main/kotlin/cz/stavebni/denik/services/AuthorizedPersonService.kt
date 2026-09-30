package cz.stavebni.denik.services

import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import kotlinx.serialization.Serializable
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

        return AuditService.auditedTransaction(
            actor = actor,
            action = "authorizedPerson.create",
            entityType = "project",
            entityId = projectId.toString(),
        ) { tx ->
            ProjectAccess.requireAccess(tx, actor, projectId)
            tx.insertInto(AUTHORIZED_PERSONS)
                .set(AUTHORIZED_PERSONS.PROJECTID, projectId)
                .set(AUTHORIZED_PERSONS.NAME, name)
                .set(AUTHORIZED_PERSONS.COMPANY, req.company?.trim()?.ifEmpty { null })
                .set(AUTHORIZED_PERSONS.AUTHORIZATION, req.authorization?.trim()?.ifEmpty { null })
                .set(AUTHORIZED_PERSONS.LINKEDUSERID, linkedUserId)
                .set(AUTHORIZED_PERSONS.UPDATEDAT, OffsetDateTime.now())
                .returning()
                .fetchOne()
                ?.let { toDto(it) }
                ?: throw IllegalStateException("Nepodařilo se uložit pověřenou osobu")
        }
    }

    suspend fun revoke(actor: SessionUser, personId: UUID): AuthorizedPersonDto {
        assertCan(actor, Action.ProjectMemberManage)
        return AuditService.auditedTransaction(
            actor = actor,
            action = "authorizedPerson.revoke",
            entityType = "authorizedPerson",
            entityId = personId.toString(),
        ) { tx ->
            val projectId = tx.select(AUTHORIZED_PERSONS.PROJECTID)
                .from(AUTHORIZED_PERSONS)
                .where(AUTHORIZED_PERSONS.ID.eq(personId))
                .fetchOne()?.value1()
                ?: throw NotFoundException("Pověřená osoba nenalezena")
            ProjectAccess.requireAccess(tx, actor, projectId)

            val now = OffsetDateTime.now()
            tx.update(AUTHORIZED_PERSONS)
                .set(AUTHORIZED_PERSONS.REVOKEDAT, now)
                .set(AUTHORIZED_PERSONS.UPDATEDAT, now)
                .where(AUTHORIZED_PERSONS.ID.eq(personId))
                .returning()
                .fetchOne()
                ?.let { toDto(it) }
                ?: throw NotFoundException("Pověřená osoba nenalezena")
        }
    }

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
