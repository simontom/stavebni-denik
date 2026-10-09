package cz.stavebni.denik.services

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.NotFoundException
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.domain.TooManyRequestsException
import cz.stavebni.denik.domain.UnauthenticatedException
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
    /** SHA-256 recorded when the entry was signed; null for an entry that is not signed (or was signed before hashes existed). */
    val signatureHash: String? = null,
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
 * and the hashes of the photos (the hash of each stored file, recorded at upload). It is built from stored rows only,
 * never from the request, so signing and checking later hash exactly the same thing.
 *
 * What it adds to the audit log: the audit log shows *that* the entry was signed and how it looked in text; this hash is
 * checked against the entry as it is *now*, so a change made to the row (or to a photo file) behind the application's back
 * is found without having to rewrite the whole chain to hide it. It is not a qualified electronic signature: that is a
 * separate decision for later (see PROJECT.md).
 */
object ReportSignature {

    /** Bump when the covered content changes: old signatures keep verifying under the version they were made with. */
    private const val FORMAT = 1

    private fun sha256(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun parseOrString(raw: String?): JsonElement =
        if (raw == null) JsonNull else runCatching { Json.parseToJsonElement(raw) }.getOrElse { JsonPrimitive(raw) }

    /** The covered content, as the entry [report] stands (signedAt and signedById included). */
    internal fun content(tx: DSLContext, report: DailyReportsRecord, signedAt: OffsetDateTime, signedById: UUID): JsonObject {
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
            put("format", FORMAT)
            put("id", report.id.toString())
            put("projectId", report.projectid.toString())
            put("date", report.date.toString())
            put("sequenceNumber", report.get(DAILY_REPORTS.SEQUENCENUMBER)!!)
            put("authorId", report.get(DAILY_REPORTS.AUTHORID).toString())
            put("workDescription", report.workdescription ?: "")
            put("workersByTrade", parseOrString(report.workersbytrade?.data()))
            put("isControlDay", report.iscontrolday ?: false)
            put("constructionObj", report.constructionobj)
            put("weather", parseOrString(report.weather?.data()))
            put("isLateEntry", report.islateentry ?: false)
            put("lateEntryReason", report.lateentryreason)
            put("signedAt", AuditHash.formatTs(signedAt))
            put("signedById", signedById.toString())
            put("photos", JsonArray(photos))
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
        val signer = tx.select(USERS.DISPLAYNAME, USERS.CKAITNUMBER).from(USERS).where(USERS.ID.eq(signerId)).fetchOne()
        val recorded = report.get(DAILY_REPORTS.SIGNATUREHASH)

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
            signedByName = signer?.get(USERS.DISPLAYNAME),
            signerCkaitNumber = signer?.get(USERS.CKAITNUMBER),
            signatureHash = recorded,
            contentMatches = recorded?.let { it == hash(tx, report, signedAt, signerId) },
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
            if (check.signatureHash == null) withoutHash++
            if (check.contentMatches == false) problems += "entry $id: the content no longer matches the signature"
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
