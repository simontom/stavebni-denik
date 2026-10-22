package cz.stavebni.denik.services

import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.jooq.enums.Role
import cz.stavebni.denik.jooq.tables.records.ProjectsRecord
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.util.Dates
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jooq.DSLContext
import org.jooq.TableField
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.HexFormat
import java.util.UUID

/** The site manager of part A, with the name and the ČKAIT number their account had when the snapshot was made. */
@Serializable
data class PartAPerson(val ckaitNumber: String?, val name: String, val userId: String)

/** A member who ensures the technical management of the works (BOSS) or supervises them (INSPECTOR), with the scope of their authorisation and responsibility (příloha 12 A d)). */
@Serializable
data class PartAMember(val ckaitNumber: String?, val name: String, val role: String, val scope: String?, val userId: String)

/** A person who may make entries in the diary (§ 166 odst. 2), with their function (příloha 12 A f)). */
@Serializable
data class PartAAuthorizedPerson(val authorization: String?, val company: String?, val id: String, val name: String)

/**
 * Part A of the diary, the identification (vyhláška 131/2024 Sb., příloha 12, part A): the data that signature format 3
 * freezes. The property names are the keys of the stored text and are **frozen with the format**: renaming one, or adding
 * one, is a format 4. A property has no default, so every key is always written (a missing value is `null`).
 */
@Serializable
data class PartA(
    /** The persons who may make entries, only those who were not revoked at that moment, oldest first. */
    val authorizedPersons: List<PartAAuthorizedPerson>,
    /** The fields of [PartASnapshot.IDENTIFICATION_KEYS] as text (a day as `YYYY-MM-DD`), `null` for what was not entered. */
    val identification: Map<String, String?>,
    /** The members whose role is BOSS or INSPECTOR, oldest membership first. */
    val members: List<PartAMember>,
    val projectId: String,
    val siteManager: PartAPerson,
)

/**
 * The identification of the diary as it stood at one moment, which signature format 3 stores with the entry
 * (`daily_reports.partASnapshot`), so that the PDF prints part A as it was on the day of signing and the signature covers it.
 *
 * It is **text**, canonical JSON (sorted keys, compact, the same writer as the rest of the signed content), stored and hashed
 * exactly as it is: a check hashes the stored text and never builds it again, so nothing here can change what an existing
 * signature covers. [read] is the same data read from the database now, for a document made before an entry is signed.
 *
 * Its size is bounded. Every text has the limit of the field it comes from (they are the limits of the services that write
 * them), at most [MAX_PERSONS] members with a role of BOSS or INSPECTOR and [MAX_PERSONS] active authorised persons are
 * allowed (the services refuse another), and [build] refuses more than [MAX_BYTES] of text with a message. Any text of ordinary
 * characters fits with room to spare (about 740 KB at the most, every character taking four bytes); what can exceed it is a
 * project whose fields are filled to their limits with control characters, which the text is written as six bytes each (`\u0001`).
 */
object PartASnapshot {
    /** The most BOSS and INSPECTOR members, and the most active authorised persons, a project may have. */
    const val MAX_PERSONS = 100

    /** The longest snapshot that is stored, in bytes of UTF-8. */
    const val MAX_BYTES = 1_048_576

    private class IdentificationField(val key: String, val column: TableField<ProjectsRecord, *>)

    /** The columns of `projects` that are part A, with their keys, in the order of the form. **Frozen with format 3.** */
    private val IDENTIFICATION: List<IdentificationField> = listOf(
        IdentificationField("name", PROJECTS.NAME),
        IdentificationField("address", PROJECTS.ADDRESS),
        IdentificationField("cadastralArea", PROJECTS.CADASTRALAREA),
        IdentificationField("parcelNumbers", PROJECTS.PARCELNUMBERS),
        IdentificationField("builder", PROJECTS.BUILDER),
        IdentificationField("contractor", PROJECTS.CONTRACTOR),
        IdentificationField("permitNumber", PROJECTS.PERMITNUMBER),
        IdentificationField("permitDate", PROJECTS.PERMITDATE),
        IdentificationField("designerName", PROJECTS.DESIGNERNAME),
        IdentificationField("authorSupervisionName", PROJECTS.AUTHORSUPERVISIONNAME),
        IdentificationField("authorSupervisionAuthorization", PROJECTS.AUTHORSUPERVISIONAUTHORIZATION),
        IdentificationField("tdsName", PROJECTS.TDSNAME),
        IdentificationField("bozpName", PROJECTS.BOZPNAME),
        IdentificationField("contractNumber", PROJECTS.CONTRACTNUMBER),
        IdentificationField("contractDate", PROJECTS.CONTRACTDATE),
        IdentificationField("designDocVersion", PROJECTS.DESIGNDOCVERSION),
        IdentificationField("designDocDate", PROJECTS.DESIGNDOCDATE),
        IdentificationField("subcontractors", PROJECTS.SUBCONTRACTORS),
        IdentificationField("supportingDocuments", PROJECTS.SUPPORTINGDOCUMENTS),
    )

    /** The keys of `identification`, frozen with format 3 (a test fails when a column of the project is neither one of them nor listed as not part A). */
    val IDENTIFICATION_KEYS: List<String> = IDENTIFICATION.map { it.key }

    private val lenient = Json { ignoreUnknownKeys = true }
    private val HEX = HexFormat.of()

    /** A person's text as the document prints it: trimmed, and nothing at all when it is blank. */
    private fun text(value: String?): String? = value?.trim()?.ifEmpty { null }

    /** Part A as it stands in the database now, for [projectId]. Not bounded: a document can always be made (see [build]). */
    fun read(tx: DSLContext, projectId: UUID): PartA {
        val project = tx.selectFrom(PROJECTS).where(PROJECTS.ID.eq(projectId)).fetchOne() ?: throw NotFoundException("Projekt nenalezen")
        val identification = IDENTIFICATION.associate { field ->
            val value = project.get(field.column)
            field.key to when (value) {
                null -> null
                is OffsetDateTime -> Dates.format(value)
                else -> value.toString()
            }
        }

        val siteManagerId = project.get(PROJECTS.SITEMANAGERID)!!
        val manager = tx.select(USERS.DISPLAYNAME, USERS.CKAITNUMBER).from(USERS).where(USERS.ID.eq(siteManagerId)).fetchOne()
        val siteManager = PartAPerson(
            ckaitNumber = text(manager?.get(USERS.CKAITNUMBER)),
            name = text(manager?.get(USERS.DISPLAYNAME)) ?: "",
            userId = siteManagerId.toString(),
        )

        val members = tx.select(PROJECT_MEMBERS.USERID, USERS.DISPLAYNAME, PROJECT_MEMBERS.ROLE, USERS.CKAITNUMBER, PROJECT_MEMBERS.SCOPE)
            .from(PROJECT_MEMBERS)
            .join(USERS).on(USERS.ID.eq(PROJECT_MEMBERS.USERID))
            .where(PROJECT_MEMBERS.PROJECTID.eq(projectId))
            .and(PROJECT_MEMBERS.ROLE.`in`(Role.BOSS, Role.INSPECTOR))
            .and(USERS.DELETEDAT.isNull)
            .orderBy(PROJECT_MEMBERS.ADDEDAT.asc(), PROJECT_MEMBERS.USERID.asc())
            .fetch()
            .map {
                PartAMember(
                    ckaitNumber = text(it.get(USERS.CKAITNUMBER)),
                    name = text(it.get(USERS.DISPLAYNAME)) ?: "",
                    role = it.get(PROJECT_MEMBERS.ROLE)!!.name,
                    scope = text(it.get(PROJECT_MEMBERS.SCOPE)),
                    userId = it.get(PROJECT_MEMBERS.USERID).toString(),
                )
            }

        val persons = tx.selectFrom(AUTHORIZED_PERSONS)
            .where(AUTHORIZED_PERSONS.PROJECTID.eq(projectId).and(AUTHORIZED_PERSONS.REVOKEDAT.isNull))
            .orderBy(AUTHORIZED_PERSONS.CREATEDAT.asc(), AUTHORIZED_PERSONS.ID.asc())
            .fetch()
            .map {
                PartAAuthorizedPerson(
                    authorization = text(it.get(AUTHORIZED_PERSONS.AUTHORIZATION)),
                    company = text(it.get(AUTHORIZED_PERSONS.COMPANY)),
                    id = it.get(AUTHORIZED_PERSONS.ID).toString(),
                    name = text(it.get(AUTHORIZED_PERSONS.NAME)) ?: "",
                )
            }

        return PartA(authorizedPersons = persons, identification = identification, members = members, projectId = projectId.toString(), siteManager = siteManager)
    }

    /**
     * How many members with a role of BOSS or INSPECTOR the project has, **as the list of members shows them**: the memberships of
     * users who were deleted are not in the list and not in the snapshot, and nobody can remove them, so they do not count against
     * the limit either. One rule for the snapshot ([build]) and for adding a member (`ProjectMemberService.addMember`).
     */
    fun countMembersWithRole(tx: DSLContext, projectId: UUID): Int =
        tx.fetchCount(
            tx.selectOne().from(PROJECT_MEMBERS).join(USERS).on(USERS.ID.eq(PROJECT_MEMBERS.USERID))
                .where(PROJECT_MEMBERS.PROJECTID.eq(projectId)).and(PROJECT_MEMBERS.ROLE.`in`(Role.BOSS, Role.INSPECTOR)).and(USERS.DELETEDAT.isNull),
        )

    /** The canonical text of [partA]: sorted keys, compact. This exact text is stored and hashed. */
    fun textOf(partA: PartA): String = AuditHash.canonicalJson(Json.encodeToJsonElement(PartA.serializer(), partA))

    /**
     * The text to store with a signature: part A as it stands now, refused with a [ConflictException] (409) when it is larger
     * than it may be. The counts are checked **before** the persons are read, so a project with an absurd number of them cannot
     * make a signature read them all.
     */
    fun build(tx: DSLContext, projectId: UUID): String {
        val members = countMembersWithRole(tx, projectId)
        val persons = tx.fetchCount(AUTHORIZED_PERSONS, AUTHORIZED_PERSONS.PROJECTID.eq(projectId).and(AUTHORIZED_PERSONS.REVOKEDAT.isNull))
        if (members > MAX_PERSONS || persons > MAX_PERSONS) throw tooLarge()
        val text = textOf(read(tx, projectId))
        if (text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) throw tooLarge()
        return text
    }

    private fun tooLarge() = ConflictException(
        "Údaje o stavbě (texty, osoby a pověřené osoby) jsou příliš rozsáhlé, než aby je šlo uložit s podpisem. " +
            "Zkraťte texty v údajích o stavbě nebo odeberte osoby, které už nejsou potřeba, a podepište znovu.",
    )

    /** Reads a stored snapshot. A text that is not one is a [kotlinx.serialization.SerializationException]. */
    fun parse(text: String): PartA = lenient.decodeFromString(PartA.serializer(), text)

    /** The SHA-256 of the stored text, as 64 lower-case hex characters: what the signature covers of it (`partASha256`). */
    fun sha256(text: String): String = HEX.formatHex(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)))
}
