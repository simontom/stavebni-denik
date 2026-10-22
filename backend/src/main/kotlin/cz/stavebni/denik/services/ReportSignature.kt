package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.TooManyRequestsException
import cz.stavebni.denik.domain.UnauthenticatedException
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.jooq.tables.records.DailyReportsRecord
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.jooq.DSLContext
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.UUID

/** Who signed, with what number, and whether what the signature covers is still what was signed. */
@Serializable
data class SignatureCheckDto(
    val reportId: String,
    val signed: Boolean,
    val signedAt: String? = null,
    val signedById: String? = null,
    val signedByName: String? = null,
    val signerCkaitNumber: String? = null,
    /** The name and the number above are the ones stored when the entry was signed (format 3), not those the account has now. */
    val signerFrozen: Boolean = false,
    /** Format 3 only: what the signature needs and the row lacks (`signerName`, `signerCkaitNumber`, `partASnapshot`); empty when nothing is missing. */
    val missingFields: List<String> = emptyList(),
    /** SHA-256 recorded when the entry was signed; null for an entry that is not signed (or was signed before hashes existed). */
    val signatureHash: String? = null,
    /** Which fields the signature covers (see [ReportSignature.CURRENT_FORMAT]); null for an entry that is not signed. */
    val signatureFormat: Int? = null,
    /** The content hashed again now equals the recorded hash. Null when there is no recorded hash to compare with. */
    val contentMatches: Boolean? = null,
    /** The photo files on disk still hash to what was recorded at upload. Null when no photo has a recorded hash. */
    val photoFilesMatch: Boolean? = null,
    val checkedAt: String,
)

/**
 * The signature of a daily report (decision D8): a SHA-256 over the canonical content of the entry at the moment it was
 * signed, recorded in the same statement that locks it.
 *
 * What it covers: the text fields, the workers list, the weather, the late-entry flag and reason, who signed and when,
 * and the hashes of the photos (the hash of each stored file, recorded at upload). Format 3 also covers who signed (the
 * name and the ČKAIT number stored with the entry, not read from the account) and the identification of the diary as it
 * stood when the entry was signed (the SHA-256 of the text stored in `partASnapshot`), and covers the weather as its text. It
 * is built from stored rows only, never from the request, so signing and checking later hash exactly the same thing.
 *
 * What it adds to the audit log: the audit log shows *that* the entry was signed and how it looked in text; this hash is
 * checked against the entry as it is *now*, so a change made to the row (or to a photo file) behind the application's back
 * is found without having to rewrite the whole chain to hide it. It is not a qualified electronic signature: that is a
 * separate decision for later (see PROJECT.md).
 */
object ReportSignature {

    /**
     * The format new signatures are made in. 1 is the entry without the fields of [EntryDetails]; 2 covers them too; 3 also
     * covers the signer's stored name and number, part A as it stood ([PartASnapshot]), the start and interruption of work and
     * the weather as its text. An entry says which one it was signed in (`signatureFormat`), so what was signed before a field
     * existed still verifies. Bump it only for a new frozen format; never change an existing one.
     */
    const val CURRENT_FORMAT = 3

    /**
     * The fields of [EntryDetails] that format 2 covers, **frozen**. Format 2 must mean the same thing forever: a signature
     * made today has to verify in ten years, so it cannot follow the live list of fields. Adding a field to [EntryDetails]
     * means a format 3 that covers it (and a test, EntryDetailsTest, fails until that is done); removing or renaming a key
     * would break every signature of format 2 and must not be done.
     */
    internal val FORMAT_2_DETAIL_KEYS: List<String> =
        listOf("materials", "machinery", "testsAndChecks", "safetyNotes", "dustMeasures", "accessibilityMeasures", "defects", "otherNotes")

    /**
     * The fields of [EntryDetails] that format 3 covers, **frozen**: the eight of format 2 and `workStateChanges` (the start,
     * interruption and resumption of work, příloha 12 B.2 b)). The keys are the API's; never rename or remove one. A tenth field
     * is a format 4.
     */
    internal val FORMAT_3_DETAIL_KEYS: List<String> =
        listOf(
            "materials", "machinery", "testsAndChecks", "safetyNotes", "dustMeasures", "accessibilityMeasures", "defects",
            "workStateChanges", "otherNotes",
        )

    private fun detailKeysOf(format: Int): List<String> = if (format >= 3) FORMAT_3_DETAIL_KEYS else FORMAT_2_DETAIL_KEYS

    /**
     * The columns of `daily_reports` that format 3 covers besides the fields of [EntryDetails], **frozen**: each is a key of the
     * content, spelled as the column is. The photos (their own table), `format`, `details` and `partASha256` are keys too. A
     * test fails when a column is added to the table and is neither here nor listed as not covered.
     */
    internal val FORMAT_3_COLUMNS: List<org.jooq.TableField<DailyReportsRecord, *>> = listOf(
        DAILY_REPORTS.ID, DAILY_REPORTS.PROJECTID, DAILY_REPORTS.DATE, DAILY_REPORTS.SEQUENCENUMBER, DAILY_REPORTS.AUTHORID,
        DAILY_REPORTS.WORKDESCRIPTION, DAILY_REPORTS.WORKERSBYTRADE, DAILY_REPORTS.ISCONTROLDAY, DAILY_REPORTS.CONSTRUCTIONOBJ,
        DAILY_REPORTS.WEATHER, DAILY_REPORTS.ISLATEENTRY, DAILY_REPORTS.LATEENTRYREASON, DAILY_REPORTS.SIGNEDAT, DAILY_REPORTS.SIGNEDBYID,
        DAILY_REPORTS.SIGNERNAME, DAILY_REPORTS.SIGNERCKAITNUMBER,
    )

    /** What format 3 needs of the row and a row may lack: the name of the column and its value, `null` when it is missing or blank. */
    private fun storedOfFormat3(report: DailyReportsRecord): List<Pair<String, String?>> = listOf(
        "signerName" to report.get(DAILY_REPORTS.SIGNERNAME)?.takeIf { it.isNotBlank() },
        "signerCkaitNumber" to report.get(DAILY_REPORTS.SIGNERCKAITNUMBER)?.takeIf { it.isNotBlank() },
        "partASnapshot" to report.get(DAILY_REPORTS.PARTASNAPSHOT)?.takeIf { it.isNotBlank() },
    )

    /** The weather as the text that is signed in format 3 (`WeatherData.describe()`), `null` when nothing is stated. */
    private fun weatherText(report: DailyReportsRecord): String? = WeatherData.fromStored(report.weather?.data())?.describe()

    private fun sha256(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun parseOrString(raw: String?): JsonElement =
        if (raw == null) JsonNull else runCatching { Json.parseToJsonElement(raw) }.getOrElse { JsonPrimitive(raw) }

    /** The covered content, as the entry [report] stands (signedAt and signedById included). */
    internal fun content(tx: DSLContext, report: DailyReportsRecord, signedAt: OffsetDateTime, signedById: UUID): JsonObject {
        val format = report.get(DAILY_REPORTS.SIGNATUREFORMAT)?.toInt() ?: 1
        val photos = tx.selectFrom(PHOTOS)
            .where(PHOTOS.REPORTID.eq(report.id!!).and(PHOTOS.DELETEDAT.isNull))
            .fetch()
            .map { p ->
                buildJsonObject {
                    put("id", p.get(PHOTOS.ID).toString())
                    put("sha256", p.get(PHOTOS.SHA256))
                    put("thumbSha256", p.get(PHOTOS.THUMBSHA256))
                    put("uploadedById", p.get(PHOTOS.UPLOADEDBYID).toString())
                }
            }
            .sortedBy { (it["id"] as JsonPrimitive).content }
        return buildJsonObject {
            put("format", format)
            put("id", report.id.toString())
            put("projectId", report.projectid.toString())
            put("date", report.date.toString())
            put("sequenceNumber", report.get(DAILY_REPORTS.SEQUENCENUMBER)!!)
            put("authorId", report.get(DAILY_REPORTS.AUTHORID).toString())
            put("workDescription", report.workdescription ?: "")
            put("workersByTrade", parseOrString(report.workersbytrade?.data()))
            put("isControlDay", report.iscontrolday ?: false)
            put("constructionObj", report.constructionobj)
            put("weather", if (format >= 3) JsonPrimitive(weatherText(report)) else parseOrString(report.weather?.data()))
            put("isLateEntry", report.islateentry ?: false)
            put("lateEntryReason", report.lateentryreason)
            put("signedAt", AuditHash.formatTs(signedAt))
            put("signedById", signedById.toString())
            put("photos", JsonArray(photos))
            if (format >= 2) {
                val fields = EntryDetails.FIELDS.associateBy { it.key }
                put(
                    "details",
                    buildJsonObject {
                        detailKeysOf(format).forEach { key ->
                            val field = checkNotNull(fields[key]) { "the field '$key' is covered by signature format $format and cannot be removed" }
                            put(key, report.get(field.column)?.takeIf { it.isNotBlank() })
                        }
                    },
                )
            }
            if (format >= 3) {
                // What the signature needs is stored with the entry: a row that lacks it cannot be hashed (check() says so first).
                val stored = storedOfFormat3(report).associate { (name, value) -> name to checkNotNull(value) { "signature format 3 needs $name, and the entry has none" } }
                put("signerName", stored.getValue("signerName"))
                put("signerCkaitNumber", stored.getValue("signerCkaitNumber"))
                // The text exactly as it is stored, never built again: what is hashed is what is kept.
                put("partASha256", PartASnapshot.sha256(stored.getValue("partASnapshot")))
            }
        }
    }

    fun hash(tx: DSLContext, report: DailyReportsRecord, signedAt: OffsetDateTime, signedById: UUID): String =
        sha256(AuditHash.canonicalJson(content(tx, report, signedAt, signedById)))

    /** Checks a stored signature against the entry as it is now. */
    fun check(tx: DSLContext, reportId: UUID): SignatureCheckDto {
        val report = tx.selectFrom(DAILY_REPORTS)
            .where(DAILY_REPORTS.ID.eq(reportId).and(DAILY_REPORTS.DELETEDAT.isNull))
            .fetchOne() ?: throw NotFoundException("Záznam nenalezen")
        val now = AuditHash.formatTs(OffsetDateTime.now())
        val signedAt = report.signedat
        val signerId = report.get(DAILY_REPORTS.SIGNEDBYID)
        if (report.lockedat == null || signedAt == null || signerId == null) {
            return SignatureCheckDto(reportId = reportId.toString(), signed = false, checkedAt = now)
        }
        val recorded = report.get(DAILY_REPORTS.SIGNATUREHASH)
        val format = report.get(DAILY_REPORTS.SIGNATUREFORMAT)?.toInt() ?: 1
        // From format 3 on who signed is stored with the signature; before, it is read from the account as it is now.
        val frozen = format >= 3
        val missing = if (frozen) storedOfFormat3(report).filter { it.second == null }.map { it.first } else emptyList()
        val signer = if (frozen) null else tx.select(USERS.DISPLAYNAME, USERS.CKAITNUMBER).from(USERS).where(USERS.ID.eq(signerId)).fetchOne()

        val photoRows = tx.select(PHOTOS.PATHORIGINAL, PHOTOS.PATHTHUMB, PHOTOS.SHA256, PHOTOS.THUMBSHA256)
            .from(PHOTOS)
            .where(PHOTOS.REPORTID.eq(reportId).and(PHOTOS.DELETEDAT.isNull))
            .fetch()
        val hashed = photoRows.filter { it.get(PHOTOS.SHA256) != null }
        val filesMatch = if (hashed.isEmpty()) null else hashed.all { row ->
            fileMatches(row.get(PHOTOS.PATHORIGINAL)!!, row.get(PHOTOS.SHA256)!!) &&
                (row.get(PHOTOS.THUMBSHA256) == null || fileMatches(row.get(PHOTOS.PATHTHUMB)!!, row.get(PHOTOS.THUMBSHA256)!!))
        }

        return SignatureCheckDto(
            reportId = reportId.toString(),
            signed = true,
            signedAt = signedAt.toString(),
            signedById = signerId.toString(),
            signedByName = if (frozen) report.get(DAILY_REPORTS.SIGNERNAME) else signer?.get(USERS.DISPLAYNAME),
            signerCkaitNumber = if (frozen) report.get(DAILY_REPORTS.SIGNERCKAITNUMBER) else signer?.get(USERS.CKAITNUMBER),
            signerFrozen = frozen,
            missingFields = missing,
            signatureHash = recorded,
            signatureFormat = format,
            // Format 1 includes entries signed before hashes existed, which have nothing to compare. From format 2 on every
            // signature has a hash, so a missing one means it was removed: that is a mismatch, not "nothing to compare". The
            // same holds for what format 3 stores with the entry: without it the content cannot even be built, and that is a
            // failure of the signature.
            contentMatches = when {
                recorded == null -> if (format >= 2) false else null
                missing.isNotEmpty() -> false
                else -> recorded == hash(tx, report, signedAt, signerId)
            },
            photoFilesMatch = filesMatch,
            checkedAt = now,
        )
    }

    /** The result of checking every signed entry of the database. */
    class AllResult(
        val signed: Int,
        /** Signed entries that carry no recorded hash (signed before hashes existed): nothing to compare, not a failure. */
        val withoutHash: Int,
        /** Entries whose content no longer hashes to what was recorded, or whose photo files no longer match. */
        val problems: List<String>,
    ) {
        val ok: Boolean get() = problems.isEmpty()
    }

    /**
     * Checks every signed entry: its content against the recorded hash and its photo files against the hashes recorded at
     * upload. This is what a backup restore, or a nightly check, runs to prove that nothing signed has changed.
     */
    fun checkAll(tx: DSLContext): AllResult {
        val ids = tx.select(DAILY_REPORTS.ID).from(DAILY_REPORTS)
            .where(DAILY_REPORTS.LOCKEDAT.isNotNull.and(DAILY_REPORTS.DELETEDAT.isNull))
            .orderBy(DAILY_REPORTS.DATE.asc(), DAILY_REPORTS.ID.asc())
            .fetch(DAILY_REPORTS.ID).filterNotNull()
        var withoutHash = 0
        val problems = mutableListOf<String>()
        for (id in ids) {
            val check = check(tx, id)
            // Selected because it is locked, but check() found no signer or no time of signing: an entry that cannot be
            // checked is not one that has "nothing to compare".
            if (!check.signed) {
                problems += "entry $id: it is locked but has no signer or no time of signing, so its signature cannot be checked"
                continue
            }
            if (check.signatureHash == null && (check.signatureFormat ?: 1) < 2) withoutHash++
            if (check.signatureHash == null && (check.signatureFormat ?: 1) >= 2) {
                problems += "entry $id: signed in format ${check.signatureFormat} but its signature hash is missing"
            } else if (check.missingFields.isNotEmpty()) {
                problems += "entry $id: signed in format ${check.signatureFormat} but what the signature stores is missing: ${check.missingFields.joinToString(", ")}"
            } else if (check.contentMatches == false) {
                problems += "entry $id: the content no longer matches the signature"
            }
            if (check.photoFilesMatch == false) problems += "entry $id: a photo file no longer matches its recorded hash"
        }
        return AllResult(signed = ids.size, withoutHash = withoutHash, problems = problems)
    }

    private fun fileMatches(storageKey: String, expectedSha256: String): Boolean {
        val path = PhotoStorage.resolve(storageKey) ?: return false
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            java.nio.file.Files.newInputStream(path).use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            digest.digest().joinToString("") { "%02x".format(it) } == expectedSha256
        } catch (e: java.io.IOException) {
            false
        }
    }
}

/**
 * Signing is an act that asks for the password again (decision D8): a stolen or left-open session alone cannot sign an
 * entry. Wrong answers are limited per person, like the "current password" of a password change.
 */
object SigningGuard {
    suspend fun confirmPassword(user: SessionUser, password: String?) {
        require(!password.isNullOrEmpty()) { "Pro podpis zadejte své heslo." }
        require(password.length <= PasswordPolicy.MAX_LENGTH) { "Heslo není správné." }
        val db = DatabaseFactory.dsl
        val reservation = RateLimiter.reserve(db, listOf(RateLimiter.Rules.SIGNATURE_PASSWORD to user.id.toString()))
        reservation.refusedFor?.let {
            throw TooManyRequestsException(it.seconds, "Příliš mnoho nesprávných hesel při podpisu. Zkuste to znovu za ${RateLimiter.describeWait(it)}.")
        }
        val hash = db.select(USERS.PASSWORDHASH)
            .from(USERS)
            .where(USERS.ID.eq(user.id).and(USERS.ISACTIVE.eq(true)).and(USERS.DELETEDAT.isNull))
            .fetchOne(USERS.PASSWORDHASH)
            ?: throw UnauthenticatedException()
        // The reserved attempt stays when the password is wrong, and is given back when it is right.
        require(PasswordService.verifyAsync(hash, password)) { "Heslo není správné." }
        RateLimiter.release(db, reservation)
    }
}
