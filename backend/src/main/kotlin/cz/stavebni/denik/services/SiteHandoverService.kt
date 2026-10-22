package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Action
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.HandoverSide
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.Resource
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.SignerNotQualifiedException
import cz.stavebni.denik.domain.StaleVersionException
import cz.stavebni.denik.domain.assertCan
import cz.stavebni.denik.domain.can
import cz.stavebni.denik.jooq.tables.records.SiteHandoverSignaturesRecord
import cz.stavebni.denik.jooq.tables.records.SiteHandoversRecord
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVER_SIGNATURES
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.services.AuditService.Audited
import cz.stavebni.denik.util.Dates
import cz.stavebni.denik.util.Text
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import org.jooq.DSLContext
import org.jooq.JSONB
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit
import java.util.UUID

/** Where a protocol stands: derived from its signatures, never stored. */
@Serializable
enum class SiteHandoverState { DRAFT, SIGNED_BY_CONTRACTOR, SIGNED_BY_CLIENT, COMPLETE }

/** One party's signature: who signed, in which role, with which ČKAIT number (the contractor), when, and the two hashes. */
@Serializable
data class HandoverSignatureDto(
    val side: HandoverSide,
    val signedById: String,
    val signerName: String,
    val signerRole: Role,
    val signerCkaitNumber: String? = null,
    /** UTC with milliseconds: the text that is hashed. */
    val signedAt: String,
    /** The SHA-256 of the content both parties signed (see [HandoverHash]). */
    val contentHash: String,
    val signatureHash: String,
)

@Serializable
data class SiteHandoverDto(
    val id: String? = null,
    val projectId: String,
    val type: String,
    /** YYYY-MM-DD */
    val date: String,
    val participants: String,
    val meterStates: List<MeterState>? = null,
    val notes: String? = null,
    val createdById: String? = null,
    /** The version of the content: sent back as `expectedUpdatedAt` when the protocol is changed or signed. A signature does not change it. */
    val updatedAt: String? = null,
    val state: SiteHandoverState = SiteHandoverState.DRAFT,
    val contractorSignature: HandoverSignatureDto? = null,
    val clientSignature: HandoverSignatureDto? = null,
)

/** What a client sends to make or change a protocol; a change also names the version it was based on. */
@Serializable
data class SiteHandoverInput(
    val type: String,
    /** YYYY-MM-DD, the calendar day of the handover. A time part is dropped, never converted (as for the day of an entry): `2026-09-11T00:30:00+02:00` is the 11th. */
    val date: String,
    val participants: String,
    val meterStates: List<MeterState>? = null,
    val notes: String? = null,
    /** The `updatedAt` the client saw. Required to change a protocol; ignored when one is made. */
    val expectedUpdatedAt: String? = null,
)

/** A request to sign: [side] is optional (the side follows from the role), [expectedUpdatedAt] is the version the signer looked at. */
class SignHandoverRequest(val side: HandoverSide?, val expectedUpdatedAt: OffsetDateTime)

/** What the audit log keeps of one signature of a protocol. Never a password. */
@Serializable
internal data class HandoverSignatureSnapshot(
    val signedById: String,
    val signedAt: String,
    val signerName: String,
    val signerRole: String,
    val signerCkaitNumber: String?,
    val contentHash: String,
    val signatureHash: String,
)

/**
 * What the audit log keeps of a handover protocol before and after a change. Text, booleans and whole numbers only (the
 * meter readings stay the JSON *string* that is stored), like the report snapshot; the signatures are part of it, so the row of
 * a signature shows the signature that was added.
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
    val deletedAt: String?,
    val contractorSignature: HandoverSignatureSnapshot?,
    val clientSignature: HandoverSignatureSnapshot?,
)

/**
 * Site handover protocols (předání a převzetí staveniště; backlog A3). A protocol is an act of two parties and carries one
 * signature for each side ([HandoverSide]): the contractor's manager (with a ČKAIT number, decision D2) and the client's investor
 * or technical supervision. The content is frozen from the **first** signature, so the second party signs what the first one
 * signed; the database refuses a change too (V5).
 *
 * Every write runs through [AuditService.auditedWrite]: the audit lock is taken first, the row is read `FOR UPDATE`, and the
 * membership, the role, the signatures that exist and the version are judged inside the transaction. So a protocol cannot be
 * changed after a signature or signed twice by requests that interleave, and an administrator who is not a member (who may *read*
 * every project) is never treated as a member when writing. A change and a signature both name the version they were based on
 * (`expectedUpdatedAt`, required): a signature covers the version the signer saw.
 */
object SiteHandoverService {
    /** The longest text the server accepts (characters as a person counts them), after trimming. */
    const val MAX_TYPE_CHARS = 200
    const val MAX_PARTICIPANTS_CHARS = 2000
    const val MAX_NOTES_CHARS = 5000
    const val MAX_METERS = 50
    const val MAX_METER_FIELD_CHARS = 100

    private val json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    // --- reading ------------------------------------------------------------------------------

    private fun meterStatesOf(record: SiteHandoversRecord): List<MeterState>? =
        record.get(SITE_HANDOVERS.METERSTATES)?.data()?.let { json.decodeFromString<List<MeterState>>(it) }

    private fun signatureDto(r: SiteHandoverSignaturesRecord) = HandoverSignatureDto(
        side = HandoverSide.valueOf(r.side!!),
        signedById = r.signedbyid.toString(),
        signerName = r.signername!!,
        signerRole = Role.valueOf(r.signerrole!!.name),
        signerCkaitNumber = r.signerckaitnumber,
        signedAt = AuditHash.formatTs(r.signedat!!),
        contentHash = r.contenthash!!,
        signatureHash = r.signaturehash!!,
    )

    private fun signatureSnapshot(r: SiteHandoverSignaturesRecord?) = r?.let {
        HandoverSignatureSnapshot(
            signedById = it.signedbyid.toString(),
            signedAt = AuditHash.formatTs(it.signedat!!),
            signerName = it.signername!!,
            signerRole = it.signerrole!!.name,
            signerCkaitNumber = it.signerckaitnumber,
            contentHash = it.contenthash!!,
            signatureHash = it.signaturehash!!,
        )
    }

    private fun List<SiteHandoverSignaturesRecord>.of(side: HandoverSide) = firstOrNull { it.side == side.name }

    private fun toDto(record: SiteHandoversRecord, signatures: List<SiteHandoverSignaturesRecord>): SiteHandoverDto {
        val contractor = signatures.of(HandoverSide.CONTRACTOR)
        val client = signatures.of(HandoverSide.CLIENT)
        return SiteHandoverDto(
            id = record.get(SITE_HANDOVERS.ID).toString(),
            projectId = record.get(SITE_HANDOVERS.PROJECTID).toString(),
            type = record.get(SITE_HANDOVERS.TYPE) ?: "",
            date = Dates.format(record.get(SITE_HANDOVERS.DATE)) ?: "",
            participants = record.get(SITE_HANDOVERS.PARTICIPANTS) ?: "",
            meterStates = meterStatesOf(record),
            notes = record.get(SITE_HANDOVERS.NOTES),
            createdById = record.get(SITE_HANDOVERS.CREATEDBYID)?.toString(),
            updatedAt = record.get(SITE_HANDOVERS.UPDATEDAT)?.toString(),
            state = when {
                contractor != null && client != null -> SiteHandoverState.COMPLETE
                contractor != null -> SiteHandoverState.SIGNED_BY_CONTRACTOR
                client != null -> SiteHandoverState.SIGNED_BY_CLIENT
                else -> SiteHandoverState.DRAFT
            },
            contractorSignature = contractor?.let { signatureDto(it) },
            clientSignature = client?.let { signatureDto(it) },
        )
    }

    private fun SiteHandoversRecord.toSnapshot(signatures: List<SiteHandoverSignaturesRecord>): JsonElement = json.encodeToJsonElement(
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
            deletedAt = get(SITE_HANDOVERS.DELETEDAT)?.toString(),
            contractorSignature = signatureSnapshot(signatures.of(HandoverSide.CONTRACTOR)),
            clientSignature = signatureSnapshot(signatures.of(HandoverSide.CLIENT)),
        ),
    )

    private fun signaturesOf(tx: DSLContext, handoverIds: Collection<UUID>): Map<UUID, List<SiteHandoverSignaturesRecord>> =
        if (handoverIds.isEmpty()) emptyMap()
        else tx.selectFrom(SITE_HANDOVER_SIGNATURES)
            .where(SITE_HANDOVER_SIGNATURES.HANDOVERID.`in`(handoverIds))
            .orderBy(SITE_HANDOVER_SIGNATURES.SIGNEDAT.asc(), SITE_HANDOVER_SIGNATURES.ID.asc())
            .fetch()
            .groupBy { it.handoverid!! }

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
        return toDto(record, signaturesOf(tx, listOf(handoverId))[handoverId].orEmpty())
    }

    suspend fun listHandovers(tx: DSLContext, user: SessionUser, projectId: UUID): List<SiteHandoverDto> {
        ProjectAccess.requireAccess(tx, user, projectId)
        val records = tx.selectFrom(SITE_HANDOVERS)
            .where(SITE_HANDOVERS.PROJECTID.eq(projectId).and(SITE_HANDOVERS.DELETEDAT.isNull))
            .orderBy(SITE_HANDOVERS.DATE.desc(), SITE_HANDOVERS.CREATEDAT.desc())
            .fetch()
        // The signatures of the whole list in one query, not one for each protocol.
        val signatures = signaturesOf(tx, records.mapNotNull { it.id })
        return records.map { toDto(it, signatures[it.id].orEmpty()) }
    }

    // --- the text -----------------------------------------------------------------------------

    /** What a protocol says, checked and tidied: the limits are the only bound of the text besides the size of the request. */
    private class Content(val type: String, val date: OffsetDateTime, val participants: String, val meters: List<MeterState>, val notes: String?) {
        val metersJson: JSONB? = meters.takeIf { it.isNotEmpty() }?.let { JSONB.valueOf(json.encodeToString(it)) }
    }

    private fun validated(input: SiteHandoverInput): Content {
        val type = Text.checked(input.type.trim(), "Typ předání", MAX_TYPE_CHARS)
        require(type.isNotEmpty()) { "Typ předání je povinný" }
        // A calendar day, stored at midnight UTC: the same reading as the day of an entry (a time part is dropped, not converted).
        val date = Dates.parseLocalDate(input.date).atStartOfDay().atOffset(ZoneOffset.UTC)
        val participants = Text.checked(input.participants.trim(), "Účastníci předání", MAX_PARTICIPANTS_CHARS)
        val notes = input.notes?.trim()?.takeIf { it.isNotEmpty() }?.let { Text.checked(it, "Poznámky", MAX_NOTES_CHARS) }
        val given = input.meterStates.orEmpty()
        require(given.size <= MAX_METERS) { "Protokol může mít nejvýše $MAX_METERS měřidel" }
        val meters = given
            .map { m ->
                MeterState(
                    medium = Text.checked(m.medium.trim(), "Médium měřidla", MAX_METER_FIELD_CHARS),
                    serialNumber = Text.checked(m.serialNumber.trim(), "Výrobní číslo měřidla", MAX_METER_FIELD_CHARS),
                    state = Text.checked(m.state.trim(), "Stav měřidla", MAX_METER_FIELD_CHARS),
                )
            }
            // A row that says nothing is not a meter.
            .filter { it.medium.isNotEmpty() || it.serialNumber.isNotEmpty() || it.state.isNotEmpty() }
        return Content(type, date, participants, meters, notes)
    }

    /** The version a change or a signature was based on. It is required: a change or a signature that names none could cover words the person never saw. */
    private fun expectedVersion(text: String?): OffsetDateTime {
        val value = text?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("Chybí verze protokolu (expectedUpdatedAt): načtěte protokol znovu a uložte nebo podepište jej z něj")
        return try {
            OffsetDateTime.parse(value.trim())
        } catch (e: DateTimeParseException) {
            throw IllegalArgumentException("Neplatná hodnota expectedUpdatedAt")
        }
    }

    // --- writing ------------------------------------------------------------------------------

    suspend fun createHandover(user: SessionUser, projectId: UUID, input: SiteHandoverInput): SiteHandoverDto {
        val content = validated(input)

        return AuditService.auditedWrite(user, "siteHandover") { tx ->
            if (!tx.fetchExists(PROJECTS, PROJECTS.ID.eq(projectId).and(PROJECTS.DELETEDAT.isNull))) {
                throw NotFoundException("Projekt nenalezen")
            }
            // Real membership: an app admin who is not a member may read the project, not write to it.
            val role = ProjectAccess.requireAccess(tx, user, projectId)
            assertCan(user, Action.SiteHandoverCreate, Resource(role = role))

            val record = tx.insertInto(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.PROJECTID, projectId)
                .set(SITE_HANDOVERS.TYPE, content.type)
                .set(SITE_HANDOVERS.DATE, content.date)
                .set(SITE_HANDOVERS.PARTICIPANTS, content.participants)
                .set(SITE_HANDOVERS.METERSTATES, content.metersJson)
                .set(SITE_HANDOVERS.NOTES, content.notes)
                .set(SITE_HANDOVERS.CREATEDBYID, user.id)
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .returning()
                .fetchOne() ?: throw IllegalStateException("Failed to insert site handover")

            Audited(
                result = toDto(record, emptyList()),
                action = "siteHandover.create",
                entityId = record.get(SITE_HANDOVERS.ID).toString(),
                after = record.toSnapshot(emptyList()),
            )
        }
    }

    suspend fun updateHandover(user: SessionUser, id: UUID, input: SiteHandoverInput): SiteHandoverDto {
        val content = validated(input)
        val expected = expectedVersion(input.expectedUpdatedAt)

        return AuditService.auditedWrite(user, "siteHandover") { tx ->
            val existing = lockActive(tx, id)
            val role = ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
            assertCan(user, Action.SiteHandoverUpdate, Resource(role = role, authorId = existing.get(SITE_HANDOVERS.CREATEDBYID)))
            // From the first signature on the content is what the parties signed; it is not changed any more.
            if (signaturesOf(tx, listOf(id)).isNotEmpty()) throw ConflictException("Protokol už podepsala jedna ze stran, nelze jej měnit")
            // The row is locked, so this is an atomic compare-and-set: whoever saved first wins, the other is told.
            if (!existing.get(SITE_HANDOVERS.UPDATEDAT)!!.isEqual(expected)) {
                throw StaleVersionException("Protokol mezitím změnil někdo jiný. Načtěte jej znovu, aby se jeho změny neztratily.")
            }

            // The row is locked and judged above; the database refuses a change of a signed protocol as the last word.
            val record = tx.update(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.TYPE, content.type)
                .set(SITE_HANDOVERS.DATE, content.date)
                .set(SITE_HANDOVERS.PARTICIPANTS, content.participants)
                .set(SITE_HANDOVERS.METERSTATES, content.metersJson)
                .set(SITE_HANDOVERS.NOTES, content.notes)
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .where(SITE_HANDOVERS.ID.eq(id).and(SITE_HANDOVERS.DELETEDAT.isNull))
                .returning()
                .fetchOne() ?: throw ConflictException("Předávací protokol nelze změnit")

            Audited(
                result = toDto(record, emptyList()),
                action = "siteHandover.update",
                entityId = id.toString(),
                before = existing.toSnapshot(emptyList()),
                after = record.toSnapshot(emptyList()),
            )
        }
    }

    suspend fun deleteHandover(user: SessionUser, id: UUID) {
        AuditService.auditedWrite(user, "siteHandover") { tx ->
            val existing = lockActive(tx, id)
            val role = ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
            assertCan(user, Action.SiteHandoverDelete, Resource(role = role, authorId = existing.get(SITE_HANDOVERS.CREATEDBYID)))
            if (signaturesOf(tx, listOf(id)).isNotEmpty()) throw ConflictException("Protokol už podepsala jedna ze stran, nelze jej smazat")

            val record = tx.update(SITE_HANDOVERS)
                .set(SITE_HANDOVERS.DELETEDAT, OffsetDateTime.now())
                .set(SITE_HANDOVERS.UPDATEDAT, OffsetDateTime.now())
                .where(SITE_HANDOVERS.ID.eq(id).and(SITE_HANDOVERS.DELETEDAT.isNull))
                .returning()
                .fetchOne() ?: throw ConflictException("Předávací protokol nelze smazat")

            Audited(
                result = Unit,
                action = "siteHandover.delete",
                entityId = id.toString(),
                before = existing.toSnapshot(emptyList()),
                after = record.toSnapshot(emptyList()),
            )
        }
    }

    // --- signing ------------------------------------------------------------------------------

    /** Who signs, as the account says it at this moment: the name, and for the contractor the ČKAIT number, are stored with the signature. */
    private class Signer(val side: HandoverSide, val role: Role, val name: String, val ckaitNumber: String?)

    private fun sideName(side: HandoverSide) = if (side == HandoverSide.CONTRACTOR) "zhotovitele" else "stavebníka"

    /**
     * Whether [user] may sign [handover] now, and for which side: the role in the project decides the side (and a person with none
     * is refused), a side signs once, one person signs one side, and the contractor holds a ČKAIT number. Read from [tx]: inside
     * the signing transaction on the locked row, and for the question asked before the password on the database as it is.
     */
    private fun judge(tx: DSLContext, user: SessionUser, handover: SiteHandoversRecord, requested: HandoverSide?): Signer {
        val role = ProjectAccess.roleIn(tx, user.id, handover.get(SITE_HANDOVERS.PROJECTID)!!)
        if (!can(user, Action.SiteHandoverSign, Resource(role = role))) throw ForbiddenException(Action.SiteHandoverSign)
        val side = HandoverSide.of(role)!!
        if (requested != null && requested != side) throw ForbiddenException(Action.SiteHandoverSign)

        val signatures = signaturesOf(tx, listOf(handover.id!!))[handover.id].orEmpty()
        signatures.of(side)?.let { throw ConflictException("Za ${sideName(side)} už protokol podepsal(a) ${it.signername}.") }
        if (signatures.any { it.signedbyid == user.id }) {
            throw ConflictException("Tento protokol jste už podepsal(a) za druhou stranu. Jedna osoba nemůže podepsat obě strany.")
        }

        val account = tx.select(USERS.DISPLAYNAME, USERS.CKAITNUMBER).from(USERS).where(USERS.ID.eq(user.id)).fetchOne()
        val ckait = account?.get(USERS.CKAITNUMBER)?.trim()
        // The takeover of the site is the act of the person who answers for the build, who signs its entries too (decision D2).
        if (side == HandoverSide.CONTRACTOR && ckait.isNullOrEmpty()) {
            throw SignerNotQualifiedException("K podpisu předání za zhotovitele je nutné číslo ČKAIT. Požádejte administrátora, aby je doplnil u vašeho účtu.")
        }
        // A name is required of every account, so this is a safety net: a signature that names nobody is no signature.
        val name = account?.get(USERS.DISPLAYNAME)?.trim()
        if (name.isNullOrEmpty()) throw ConflictException("Váš účet nemá vyplněné jméno. Požádejte administrátora, aby je doplnil, a podepište znovu.")
        return Signer(side, role!!, name, if (side == HandoverSide.CONTRACTOR) ckait else null)
    }

    /**
     * Whether [user] may sign this protocol (for [side], when the request names one) at all, without locking or changing anything.
     * The route asks this before it asks for the password, so a person who cannot sign is told so instead of being asked to prove
     * who they are. The answer is the side they would sign for.
     */
    fun checkMaySign(user: SessionUser, id: UUID, side: HandoverSide?): HandoverSide {
        val tx = DatabaseFactory.dsl
        val handover = tx.selectFrom(SITE_HANDOVERS)
            .where(SITE_HANDOVERS.ID.eq(id).and(SITE_HANDOVERS.DELETEDAT.isNull))
            .fetchOne() ?: throw NotFoundException("Předávací protokol nenalezen")
        return judge(tx, user, handover, side).side
    }

    suspend fun signHandover(user: SessionUser, id: UUID, request: SignHandoverRequest): SiteHandoverDto =
        AuditService.auditedWrite(user, "siteHandover") { tx ->
            val existing = lockActive(tx, id)
            // Membership is part of the same locked read: a person who left the project, or whose role changed, signs for what they are now.
            ProjectAccess.requireAccess(tx, user, existing.get(SITE_HANDOVERS.PROJECTID)!!)
            val signer = judge(tx, user, existing, request.side)
            // A signature covers a version: a signer who names the one they saw is told when it is not the stored one.
            if (!existing.get(SITE_HANDOVERS.UPDATEDAT)!!.isEqual(request.expectedUpdatedAt)) {
                throw StaleVersionException("Protokol mezitím změnil někdo jiný. Načtěte jej znovu a zkontrolujte, co podepisujete.")
            }

            // The signatures there are were made on the content as it stood. A content that is not what the first party signed (it was
            // changed behind the application's back) is not signed by the second one as if it were.
            val signatures = signaturesOf(tx, listOf(id))[id].orEmpty()
            if (signatures.any { problemOf(existing, it) != null }) {
                throw ConflictException("Obsah protokolu se od prvního podpisu změnil mimo aplikaci, proto jej nelze podepsat. Obraťte se na správce.")
            }

            // Milliseconds: what the hash covers is exactly what is stored and read back.
            val now = OffsetDateTime.now().truncatedTo(ChronoUnit.MILLIS)
            val contentHash = try {
                HandoverHash.contentHash(contentOf(existing))
            } catch (e: SerializationException) {
                throw ConflictException("Obsah protokolu nelze přečíst, proto jej nelze podepsat. Obraťte se na správce.")
            }
            val signatureHash = HandoverHash.signatureHash(
                HandoverHash.signature(signer.side, contentHash, now, user.id.toString(), signer.name, signer.role, signer.ckaitNumber),
            )
            val inserted = tx.insertInto(SITE_HANDOVER_SIGNATURES)
                .set(SITE_HANDOVER_SIGNATURES.HANDOVERID, id)
                .set(SITE_HANDOVER_SIGNATURES.SIDE, signer.side.name)
                .set(SITE_HANDOVER_SIGNATURES.SIGNEDBYID, user.id)
                .set(SITE_HANDOVER_SIGNATURES.SIGNERNAME, signer.name)
                .set(SITE_HANDOVER_SIGNATURES.SIGNERROLE, cz.stavebni.denik.jooq.enums.Role.valueOf(signer.role.name))
                .set(SITE_HANDOVER_SIGNATURES.SIGNERCKAITNUMBER, signer.ckaitNumber)
                .set(SITE_HANDOVER_SIGNATURES.SIGNEDAT, now)
                .set(SITE_HANDOVER_SIGNATURES.CONTENTHASH, contentHash)
                .set(SITE_HANDOVER_SIGNATURES.SIGNATUREHASH, signatureHash)
                .returning()
                .fetchOne() ?: throw IllegalStateException("Podpis se nepodařilo uložit")
            val all = signatures + inserted

            Audited(
                result = toDto(existing, all),
                action = "siteHandover.sign",
                entityId = id.toString(),
                before = existing.toSnapshot(signatures),
                after = existing.toSnapshot(all),
            )
        }

    // --- checking what was signed -------------------------------------------------------------

    /** The content a signature covers, built from the stored row only. */
    internal fun contentOf(record: SiteHandoversRecord): JsonObject = HandoverHash.content(
        id = record.get(SITE_HANDOVERS.ID).toString(),
        projectId = record.get(SITE_HANDOVERS.PROJECTID).toString(),
        type = record.get(SITE_HANDOVERS.TYPE) ?: "",
        date = Dates.format(record.get(SITE_HANDOVERS.DATE)) ?: "",
        participants = record.get(SITE_HANDOVERS.PARTICIPANTS) ?: "",
        meterStates = meterStatesOf(record),
        notes = record.get(SITE_HANDOVERS.NOTES),
    )

    /**
     * What is wrong with [signature] against [handover] as it is now, or null: the content must still hash to what both parties
     * signed, and the signature hash must still be what its own columns say. The answer names the protocol and the side, never
     * what they hold.
     */
    internal fun problemOf(handover: SiteHandoversRecord, signature: SiteHandoverSignaturesRecord): String? {
        val where = "protocol ${handover.id}, signature of the ${signature.side}"
        val side = HandoverSide.entries.firstOrNull { it.name == signature.side } ?: return "$where: the side is not one of the two"
        // A row made to hold something that is not a protocol (the meters are not a list) is reported, and the check goes on.
        val contentHash = try {
            HandoverHash.contentHash(contentOf(handover))
        } catch (e: SerializationException) {
            return "$where: the content cannot be read"
        }
        if (signature.contenthash != contentHash) return "$where: the content no longer matches what was signed"
        val expected = HandoverHash.signatureHash(
            HandoverHash.signature(
                side, contentHash, signature.signedat!!, signature.signedbyid.toString(), signature.signername!!,
                Role.valueOf(signature.signerrole!!.name), signature.signerckaitnumber,
            ),
        )
        return if (signature.signaturehash != expected) "$where: the signature hash is not the one its own columns give" else null
    }

    /** The result of checking every signature of every protocol. */
    class AllResult(val signatures: Int, val problems: List<String>) {
        val ok: Boolean get() = problems.isEmpty()
    }

    /**
     * Hashes the content of every signed protocol again and checks it, and every signature hash, against what was stored when the
     * parties signed: a change made to a protocol behind the application's back is found. (What the chain proves, and what it
     * cannot, is the same as for the entries: see PROJECT.md.)
     */
    fun checkAll(tx: DSLContext): AllResult {
        val signatures = tx.selectFrom(SITE_HANDOVER_SIGNATURES).orderBy(SITE_HANDOVER_SIGNATURES.HANDOVERID.asc(), SITE_HANDOVER_SIGNATURES.SIDE.asc()).fetch()
        val handovers = tx.selectFrom(SITE_HANDOVERS)
            .where(SITE_HANDOVERS.ID.`in`(signatures.mapNotNull { it.handoverid }.toSet()))
            .fetch()
            .associateBy { it.id }
        val problems = mutableListOf<String>()
        for (signature in signatures) {
            val handover = handovers[signature.handoverid]
            if (handover == null) {
                problems += "protocol ${signature.handoverid}: a signature of the ${signature.side} belongs to no protocol"
                continue
            }
            problemOf(handover, signature)?.let { problems += it }
            if (handover.deletedat != null) problems += "protocol ${handover.id}: it carries a signature and is marked deleted"
        }
        return AllResult(signatures.size, problems)
    }
}
