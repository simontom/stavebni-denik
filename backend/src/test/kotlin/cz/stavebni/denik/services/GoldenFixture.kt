package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.records.DailyReportsRecord
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import org.jooq.DSLContext
import java.time.OffsetDateTime
import java.util.UUID

/**
 * A signed entry with fixed identifiers, built with plain SQL that works on the schema before V14 as well as after it. A
 * signature is a hash over exactly this content, so the same fixture can be signed by the code of two different versions
 * and the results compared: that is what pins what format 1 means (GoldenSignatureTest).
 */
internal object GoldenFixture {
    val signerId: UUID = UUID.fromString("11111111-1111-4111-8111-111111111111")
    val projectId: UUID = UUID.fromString("22222222-2222-4222-8222-222222222222")
    val entryId: UUID = UUID.fromString("33333333-3333-4333-8333-333333333333")
    val photoId: UUID = UUID.fromString("44444444-4444-4444-8444-444444444444")
    const val SIGNED_AT = "2026-09-28 10:15:30.123+00"

    /**
     * Inserts the signer, the project, an entry with one photo and then signs it with the given hash (null: no hash recorded
     * yet). Without the optional arguments it uses only columns that exist since V13, so it runs on the old schema too.
     * [signatureFormat] and [extraSet] (more assignments for the update that signs, for example the fields of V14) need V14.
     */
    fun insertSignedEntry(dsl: DSLContext, signatureHash: String?, signatureFormat: Int? = null, extraSet: String? = null) {
        dsl.execute(
            """insert into users (id, nickname, "displayName", "passwordHash", role, "ckaitNumber", "isAdmin", "isActive", "mustChangePwd")
               values ('$signerId', 'golden_signer', 'Golden Signer', 'x', 'BOSS', '0012345', false, true, false)"""
        )
        dsl.execute(
            """insert into projects (id, name, address, "cadastralArea", "parcelNumbers", builder, contractor, "siteManagerId")
               values ('$projectId', 'Golden', 'A 1', 'C', '1', 'B', 'C', '$signerId')"""
        )
        dsl.execute(
            """insert into daily_reports (id, "projectId", date, "authorId", "constructionObj", "isControlDay", "workersByTrade",
                                          "workDescription", weather)
               values ('$entryId', '$projectId', '2026-09-28', '$signerId', 'SO 01', true,
                       '[{"trade":"Betonáři","count":3},{"trade":"Zedníci","count":2}]'::jsonb,
                       'Betonáž stropu' || chr(10) || 'Druhý řádek',
                       '{"tempMin":8.5,"tempMax":15.0,"condition":"zataženo"}'::jsonb)"""
        )
        dsl.execute(
            """insert into photos (id, "reportId", "pathOriginal", "pathThumb", width, height, bytes, "uploadedById", "sha256", "thumbSha256")
               values ('$photoId', '$entryId', 'photos/golden.jpg', 'photos/golden-thumb.jpg', 800, 600, 1000, '$signerId',
                       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')"""
        )
        // Signed: the first entry of the project, so its number is 1 (V13).
        dsl.execute(
            """update daily_reports set "sequenceNumber" = 1, "signedAt" = '$SIGNED_AT'::timestamptz, "signedById" = '$signerId',
                                         "lockedAt" = '$SIGNED_AT'::timestamptz, "signatureHash" = ${signatureHash?.let { "'$it'" } ?: "null"}
                                         ${signatureFormat?.let { ", \"signatureFormat\" = $it" } ?: ""}
                                         ${extraSet?.let { ", $it" } ?: ""}
               where id = '$entryId'"""
        )
    }

    fun record(dsl: DSLContext): DailyReportsRecord = dsl.selectFrom(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(entryId)).fetchSingle()

    val signedAt: OffsetDateTime get() = OffsetDateTime.parse("2026-09-28T10:15:30.123Z")
}
