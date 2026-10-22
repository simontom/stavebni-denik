package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.WeatherData
import cz.stavebni.denik.jooq.enums.Role
import cz.stavebni.denik.jooq.tables.records.DailyReportsRecord
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jooq.JSONB
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.OffsetDateTime
import java.util.UUID

/**
 * The golden vectors of signature format 3 (`signature-format-3-vectors.json`). The expected texts and hashes were computed by
 * an independent implementation (`scripts/signature/verify-signature-format-3.py`, written from the specification in
 * `PROJECT.md`), so the Kotlin code is held to what the specification says and not to itself. The vectors of formats 1 and 2
 * stay where they were (`GoldenSignatureTest`). If one of these tests fails, a signature that exists somewhere no longer
 * verifies: change the code, not the vectors, or introduce a new format.
 */
class SignatureFormat3VectorsTest : BaseIntegrationTest() {

    private val vectors: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.getResourceAsStream("/signature-format-3-vectors.json")) { "the vectors are missing" }.use { it.readBytes().toString(Charsets.UTF_8) },
    ).jsonObject

    private fun JsonElement.text(): String? = (this as? JsonPrimitive)?.takeUnless { it is JsonNull }?.contentOrNull

    private fun JsonObject.str(key: String): String? = getValue(key).text()

    // --- the weather ------------------------------------------------------------------------------

    @Test
    fun `the weather is the text the vectors say`() {
        val cases = vectors.getValue("weatherCases").jsonArray
        assertTrue(cases.size >= 10)
        for (case in cases) {
            val weather = case.jsonObject.getValue("weather")
            val stored = if (weather is JsonNull) null else weather.toString()
            assertEquals(case.jsonObject.str("text"), WeatherData.fromStored(stored)?.describe(), "weather $stored")
        }
    }

    // --- part A ----------------------------------------------------------------------------------------

    @Test
    fun `the text of part A is the canonical text of its data, and its digest is the SHA-256 of that text`() {
        for ((name, case) in vectors.getValue("partA").jsonObject) {
            val text = case.jsonObject.str("text")!!
            val parsed = PartASnapshot.parse(case.jsonObject.getValue("partA").toString())

            assertEquals(text, PartASnapshot.textOf(parsed), "part A $name")
            assertEquals(case.jsonObject.str("sha256"), PartASnapshot.sha256(text), "part A $name")
            assertEquals(text, PartASnapshot.textOf(PartASnapshot.parse(text)), "reading the stored text and writing it again changes nothing ($name)")
        }
    }

    private val signer = UUID.fromString("11111111-1111-4111-8111-111111111111")
    private val inspector = UUID.fromString("44444444-4444-4444-8444-444444444444")
    private val author = UUID.fromString("99999999-9999-4999-8999-999999999999")
    private val projectId = UUID.fromString("22222222-2222-4222-8222-222222222222")

    private fun user(id: UUID, name: String, ckait: String?, nickname: String) {
        dsl.insertInto(USERS)
            .set(USERS.ID, id).set(USERS.NICKNAME, nickname).set(USERS.DISPLAYNAME, name).set(USERS.PASSWORDHASH, "x")
            .set(USERS.ROLE, Role.BOSS).set(USERS.CKAITNUMBER, ckait).set(USERS.ISACTIVE, true).set(USERS.MUSTCHANGEPWD, false)
            .execute()
    }

    private fun day(value: String?): OffsetDateTime? = value?.let { OffsetDateTime.parse("${it}T00:00:00Z") }

    /** The project, its members and its authorised persons of a part A vector, as rows in the database. */
    private fun insertPartA(partA: JsonObject) {
        val id = partA.getValue("identification").jsonObject
        fun s(key: String) = id.str(key)
        val manager = partA.getValue("siteManager").jsonObject
        for (person in listOf(manager) + partA.getValue("members").jsonArray.map { it.jsonObject }) {
            val userId = UUID.fromString(person.str("userId"))
            if (!dsl.fetchExists(USERS, USERS.ID.eq(userId))) user(userId, person.str("name")!!, person.str("ckaitNumber"), "u" + userId.toString().take(8))
        }
        dsl.insertInto(PROJECTS)
            .set(PROJECTS.ID, UUID.fromString(partA.str("projectId")))
            .set(PROJECTS.NAME, s("name")).set(PROJECTS.ADDRESS, s("address")).set(PROJECTS.CADASTRALAREA, s("cadastralArea"))
            .set(PROJECTS.PARCELNUMBERS, s("parcelNumbers")).set(PROJECTS.BUILDER, s("builder")).set(PROJECTS.CONTRACTOR, s("contractor"))
            .set(PROJECTS.SITEMANAGERID, UUID.fromString(manager.str("userId")))
            .set(PROJECTS.PERMITNUMBER, s("permitNumber")).set(PROJECTS.PERMITDATE, day(s("permitDate"))).set(PROJECTS.DESIGNERNAME, s("designerName"))
            .set(PROJECTS.AUTHORSUPERVISIONNAME, s("authorSupervisionName")).set(PROJECTS.AUTHORSUPERVISIONAUTHORIZATION, s("authorSupervisionAuthorization"))
            .set(PROJECTS.TDSNAME, s("tdsName")).set(PROJECTS.BOZPNAME, s("bozpName"))
            .set(PROJECTS.CONTRACTNUMBER, s("contractNumber")).set(PROJECTS.CONTRACTDATE, day(s("contractDate")))
            .set(PROJECTS.DESIGNDOCVERSION, s("designDocVersion")).set(PROJECTS.DESIGNDOCDATE, day(s("designDocDate")))
            .set(PROJECTS.SUBCONTRACTORS, s("subcontractors")).set(PROJECTS.SUPPORTINGDOCUMENTS, s("supportingDocuments"))
            .execute()
        val base = OffsetDateTime.parse("2026-01-01T10:00:00Z")
        partA.getValue("members").jsonArray.map { it.jsonObject }.forEachIndexed { index, member ->
            dsl.insertInto(PROJECT_MEMBERS)
                .set(PROJECT_MEMBERS.PROJECTID, projectId).set(PROJECT_MEMBERS.USERID, UUID.fromString(member.str("userId")))
                .set(PROJECT_MEMBERS.ROLE, Role.valueOf(member.str("role")!!)).set(PROJECT_MEMBERS.SCOPE, member.str("scope"))
                .set(PROJECT_MEMBERS.ADDEDAT, base.plusMinutes(index.toLong()))
                .execute()
        }
        partA.getValue("authorizedPersons").jsonArray.map { it.jsonObject }.forEachIndexed { index, person ->
            dsl.insertInto(AUTHORIZED_PERSONS)
                .set(AUTHORIZED_PERSONS.ID, UUID.fromString(person.str("id"))).set(AUTHORIZED_PERSONS.PROJECTID, projectId)
                .set(AUTHORIZED_PERSONS.NAME, person.str("name")).set(AUTHORIZED_PERSONS.COMPANY, person.str("company"))
                .set(AUTHORIZED_PERSONS.AUTHORIZATION, person.str("authorization")).set(AUTHORIZED_PERSONS.CREATEDAT, base.plusMinutes(index.toLong()))
                .execute()
        }
        // What is not part A, and so must not change the snapshot: a revoked person, a worker and an investor.
        dsl.insertInto(AUTHORIZED_PERSONS).set(AUTHORIZED_PERSONS.PROJECTID, projectId).set(AUTHORIZED_PERSONS.NAME, "Odvolaný").set(AUTHORIZED_PERSONS.REVOKEDAT, base).execute()
        val worker = UUID.fromString("88888888-8888-4888-8888-888888888888")
        user(worker, "Pavel Dělník", null, "worker")
        dsl.insertInto(PROJECT_MEMBERS).set(PROJECT_MEMBERS.PROJECTID, projectId).set(PROJECT_MEMBERS.USERID, worker).set(PROJECT_MEMBERS.ROLE, Role.WORKER).execute()
    }

    @Test
    fun `part A read from the rows is exactly the text of the vectors`() {
        for ((name, case) in vectors.getValue("partA").jsonObject) {
            clearTables()
            insertPartA(case.jsonObject.getValue("partA").jsonObject)

            assertEquals(case.jsonObject.str("text"), PartASnapshot.build(dsl, projectId), "part A $name")
        }
    }

    // --- the entry --------------------------------------------------------------------------------------

    private fun insertSignedEntry(entry: JsonObject, partAText: String) {
        val id = UUID.fromString(entry.str("id"))
        val details = entry["details"]?.takeUnless { it is JsonNull }?.jsonObject ?: JsonObject(emptyMap())
        val insert = dsl.insertInto(DAILY_REPORTS)
            .set(DAILY_REPORTS.ID, id)
            .set(DAILY_REPORTS.PROJECTID, projectId)
            .set(DAILY_REPORTS.SEQUENCENUMBER, entry.getValue("sequenceNumber").jsonPrimitive.int)
            .set(DAILY_REPORTS.DATE, java.time.LocalDate.parse(entry.str("date")))
            .set(DAILY_REPORTS.AUTHORID, UUID.fromString(entry.str("authorId")))
            .set(DAILY_REPORTS.WORKDESCRIPTION, entry.str("workDescription"))
            .set(DAILY_REPORTS.WORKERSBYTRADE, JSONB.valueOf(entry.getValue("workersByTrade").toString()))
            .set(DAILY_REPORTS.ISCONTROLDAY, entry.getValue("isControlDay").jsonPrimitive.boolean)
            .set(DAILY_REPORTS.CONSTRUCTIONOBJ, entry.str("constructionObj"))
            .set(DAILY_REPORTS.WEATHER, entry.getValue("weather").takeUnless { it is JsonNull }?.let { JSONB.valueOf(it.toString()) })
            .set(DAILY_REPORTS.ISLATEENTRY, entry.getValue("isLateEntry").jsonPrimitive.boolean)
            .set(DAILY_REPORTS.LATEENTRYREASON, entry.str("lateEntryReason"))
        for (field in EntryDetails.FIELDS) details[field.key]?.text()?.let { insert.set(field.column, it) }
        insert.execute()
        for (photo in entry.getValue("photos").jsonArray.map { it.jsonObject }) {
            dsl.insertInto(PHOTOS)
                .set(PHOTOS.ID, UUID.fromString(photo.str("id"))).set(PHOTOS.REPORTID, id)
                .set(PHOTOS.PATHORIGINAL, "photos/v.jpg").set(PHOTOS.PATHTHUMB, "photos/v-t.jpg")
                .set(PHOTOS.WIDTH, 8).set(PHOTOS.HEIGHT, 6).set(PHOTOS.BYTES, 1)
                .set(PHOTOS.UPLOADEDBYID, UUID.fromString(photo.str("uploadedById")))
                .set(PHOTOS.SHA256, photo.str("sha256")).set(PHOTOS.THUMBSHA256, photo.str("thumbSha256"))
                .set(PHOTOS.DELETEDAT, if (photo["removed"]?.jsonPrimitive?.booleanOrNull == true) OffsetDateTime.now() else null)
                .execute()
        }
        // Signed last, in one statement, as the application does: photos cannot be added to a signed entry. The number of the
        // vector is not "the next one of the project", which the trigger of V13 insists on, so it is switched off for this
        // statement (a table owner can do that).
        dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
        try {
            dsl.update(DAILY_REPORTS)
                .set(DAILY_REPORTS.SIGNEDAT, OffsetDateTime.parse(entry.str("signedAt")))
                .set(DAILY_REPORTS.LOCKEDAT, OffsetDateTime.parse(entry.str("signedAt")))
                .set(DAILY_REPORTS.SIGNEDBYID, UUID.fromString(entry.str("signedById")))
                .set(DAILY_REPORTS.SIGNATUREFORMAT, 3.toShort())
                .set(DAILY_REPORTS.SIGNERNAME, entry.str("signerName"))
                .set(DAILY_REPORTS.SIGNERCKAITNUMBER, entry.str("signerCkaitNumber"))
                .set(DAILY_REPORTS.PARTASNAPSHOT, partAText)
                .where(DAILY_REPORTS.ID.eq(id))
                .execute()
        } finally {
            dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
        }
    }

    @Test
    fun `an entry signed in format 3 means exactly what the vectors say`() {
        for ((name, case) in vectors.getValue("entries").jsonObject) {
            clearTables()
            val partA = vectors.getValue("partA").jsonObject.getValue(case.jsonObject.str("partA")!!).jsonObject
            insertPartA(partA.getValue("partA").jsonObject)
            for (extra in listOf(author)) if (!dsl.fetchExists(USERS, USERS.ID.eq(extra))) user(extra, "Autor", null, "author")
            val entry = case.jsonObject.getValue("entry").jsonObject
            insertSignedEntry(entry, partA.str("text")!!)
            val record: DailyReportsRecord = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(entry.str("id")))).fetchSingle()

            val content = ReportSignature.content(dsl, record, record.signedat!!, record.signedbyid!!)

            assertEquals(case.jsonObject.str("contentText"), AuditHash.canonicalJson(content), "the covered content of $name")
            assertEquals(case.jsonObject.str("signatureHash"), ReportSignature.hash(dsl, record, record.signedat!!, record.signedbyid!!), "the signature of $name")

            // The signature is the one that was recorded: the check passes when it is stored as it is.
            dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
            try {
                dsl.update(DAILY_REPORTS).set(DAILY_REPORTS.SIGNATUREHASH, case.jsonObject.str("signatureHash")).where(DAILY_REPORTS.ID.eq(record.id)).execute()
            } finally {
                dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
            }
            val check = ReportSignature.check(dsl, record.id!!)
            assertEquals(true, check.contentMatches, "the check of $name")
            assertEquals(3, check.signatureFormat)
        }
    }

    @Test
    fun `the vectors are of the shape the verifier and the documentation describe`() {
        assertEquals(setOf("full", "bare", "unusual"), vectors.getValue("entries").jsonObject.keys)
        assertEquals(setOf("complete", "minimal", "unusual"), vectors.getValue("partA").jsonObject.keys)
        for (case in vectors.getValue("entries").jsonObject.values) {
            val content = Json.parseToJsonElement(case.jsonObject.str("contentText")!!).jsonObject
            assertEquals(3, content.getValue("format").jsonPrimitive.int)
            assertEquals(ReportSignature.FORMAT_3_DETAIL_KEYS.toSet(), content.getValue("details").jsonObject.keys)
            assertTrue(content.getValue("photos") is JsonArray)
        }
    }
}
