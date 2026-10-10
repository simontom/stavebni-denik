package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.db.DatabaseFactory
import org.flywaydb.core.Flyway
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * Pins what a signature covers. A signature made today has to verify in ten years, whatever the code looks like by then, so
 * the content of each format is stored here as text and hash, not recomputed by the code under test.
 *
 * The format 1 vector was made by the code BEFORE signature formats existed (the last commit of main before V14), running
 * GoldenFixture; the code of this version produces exactly the same bytes. The fixture holds what could be got wrong
 * without anybody noticing: two photos listed by id and not in the order of the table, a photo that was removed (not signed),
 * a late-entry reason, and, for format 2, all eight fields (one of them only blanks, which counts as empty). The format 2 vector was made by the first version
 * of format 2. If one of these tests fails, a signature that exists somewhere no longer verifies: change the code, not the
 * test, or introduce a new format.
 */
class GoldenSignatureTest : BaseIntegrationTest() {

    private val format1Canonical =
        """{"authorId":"11111111-1111-4111-8111-111111111111","constructionObj":"SO 01","date":"2026-09-28","format":1,"id":"33333333-3333-4333-8333-333333333333","isControlDay":true,"isLateEntry":true,"lateEntryReason":"Deník byl na jiné stavbě","photos":[{"id":"00000000-0000-4000-8000-000000000001","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","thumbSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","uploadedById":"11111111-1111-4111-8111-111111111111"},{"id":"44444444-4444-4444-8444-444444444444","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","thumbSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","uploadedById":"11111111-1111-4111-8111-111111111111"}],"projectId":"22222222-2222-4222-8222-222222222222","sequenceNumber":1,"signedAt":"2026-09-28T10:15:30.123Z","signedById":"11111111-1111-4111-8111-111111111111","weather":{"condition":"zataženo","tempMax":15.0,"tempMin":8.5},"workDescription":"Betonáž stropu\nDruhý řádek","workersByTrade":[{"count":3,"trade":"Betonáři"},{"count":2,"trade":"Zedníci"}]}"""
    private val format1Hash = "bac09cd99cdbec41f9fb68684dc6adcead70806a61fe06ac3397f791f287097a"

    private val format2Canonical =
        """{"authorId":"11111111-1111-4111-8111-111111111111","constructionObj":"SO 01","date":"2026-09-28","details":{"accessibilityMeasures":"Obchozí trasa","defects":"Trhlina v omítce","dustMeasures":"Kropení","machinery":"Autodomíchávač","materials":"Beton C25/30, 12 m3","otherNotes":"Bez připomínek","safetyNotes":"Poučení provedeno","testsAndChecks":null},"format":2,"id":"33333333-3333-4333-8333-333333333333","isControlDay":true,"isLateEntry":true,"lateEntryReason":"Deník byl na jiné stavbě","photos":[{"id":"00000000-0000-4000-8000-000000000001","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","thumbSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","uploadedById":"11111111-1111-4111-8111-111111111111"},{"id":"44444444-4444-4444-8444-444444444444","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","thumbSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","uploadedById":"11111111-1111-4111-8111-111111111111"}],"projectId":"22222222-2222-4222-8222-222222222222","sequenceNumber":1,"signedAt":"2026-09-28T10:15:30.123Z","signedById":"11111111-1111-4111-8111-111111111111","weather":{"condition":"zataženo","tempMax":15.0,"tempMin":8.5},"workDescription":"Betonáž stropu\nDruhý řádek","workersByTrade":[{"count":3,"names":["Ing. Jan Novák, Ph.D.","Petr Svoboda"],"trade":"Betonáři"},{"count":2,"trade":"Zedníci"}]}"""
    private val format2Hash = "9ff791ad79bc8a4300523fb607a256e3f741e416c8c2fb44810adaef2ec87564"

    private val format2Extra =
        """"workersByTrade" = '[{"trade":"Betonáři","count":3,"names":["Ing. Jan Novák, Ph.D.","Petr Svoboda"]},{"trade":"Zedníci","count":2}]'::jsonb,
           "materialsIn" = 'Beton C25/30, 12 m3', "machinery" = 'Autodomíchávač', "testsAndChecks" = '   ',
           "safetyNotes" = 'Poučení provedeno', "dustMeasures" = 'Kropení', "accessibilityMeasures" = 'Obchozí trasa',
           "defects" = 'Trhlina v omítce', "otherNotes" = 'Bez připomínek'"""

    @Test
    fun `format 1 means exactly what it meant before formats existed`() {
        GoldenFixture.insertSignedEntry(dsl, signatureHash = format1Hash)
        val record = GoldenFixture.record(dsl)

        val content = ReportSignature.content(dsl, record, GoldenFixture.signedAt, GoldenFixture.signerId)

        assertEquals(format1Canonical, AuditHash.canonicalJson(content))
        assertEquals(format1Hash, ReportSignature.hash(dsl, record, GoldenFixture.signedAt, GoldenFixture.signerId))
        val check = ReportSignature.check(dsl, GoldenFixture.entryId)
        assertEquals(1, check.signatureFormat)
        assertEquals(true, check.contentMatches)
    }

    @Test
    fun `format 2 means exactly what it meant when it was introduced`() {
        GoldenFixture.insertSignedEntry(dsl, signatureHash = format2Hash, signatureFormat = 2, extraSet = format2Extra)
        val record = GoldenFixture.record(dsl)

        val content = ReportSignature.content(dsl, record, GoldenFixture.signedAt, GoldenFixture.signerId)

        assertEquals(format2Canonical, AuditHash.canonicalJson(content))
        assertEquals(format2Hash, ReportSignature.hash(dsl, record, GoldenFixture.signedAt, GoldenFixture.signerId))
        val check = ReportSignature.check(dsl, GoldenFixture.entryId)
        assertEquals(2, check.signatureFormat)
        assertEquals(true, check.contentMatches)
    }

    @Test
    fun `format 2 covers a frozen list of fields, whatever the list of fields becomes`() {
        assertEquals(
            listOf("materials", "machinery", "testsAndChecks", "safetyNotes", "dustMeasures", "accessibilityMeasures", "defects", "otherNotes"),
            ReportSignature.FORMAT_2_DETAIL_KEYS,
            "format 2 is frozen: its fields can never change",
        )
        assertEquals(
            ReportSignature.FORMAT_2_DETAIL_KEYS, EntryDetails.FIELDS.map { it.key },
            "A field was added to (or removed from) EntryDetails. Format 2 must not follow it: a new field needs a format 3 that " +
                "covers it (ReportSignature.CURRENT_FORMAT, content()), otherwise it is not signed, or every existing signature breaks.",
        )
    }

    @Test
    fun `an entry signed before V14 still verifies after the migration, and no signed row was touched`() {
        val scratch = "migration_" + System.nanoTime()
        dsl.execute("""create database "$scratch"""")
        val pool = DatabaseFactory.pool(postgres.jdbcUrl.replace(postgres.databaseName, scratch), postgres.username, postgres.password, maxSize = 2)
        try {
            val flyway = { target: String? ->
                Flyway.configure().dataSource(pool).locations("classpath:db/migration").apply { target?.let { target(it) } }.load()
            }
            // The schema as it was before V14, with an entry signed by the code of that time.
            flyway("13").migrate()
            val old = DSL.using(pool, SQLDialect.POSTGRES)
            GoldenFixture.insertSignedEntry(old, signatureHash = format1Hash)
            assertFalse(old.fetchExists(DSL.table("information_schema.columns"), DSL.field("column_name").eq("signatureFormat")), "the column does not exist yet")

            // The upgrade.
            flyway(null).migrate()

            val now = DSL.using(pool, SQLDialect.POSTGRES)
            assertEquals(1, (now.fetchValue("""select "signatureFormat" from daily_reports where id = ?""", GoldenFixture.entryId) as Number).toInt())
            assertEquals(format1Hash, now.fetchValue("""select "signatureHash" from daily_reports where id = ?""", GoldenFixture.entryId))
            val check = ReportSignature.check(now, GoldenFixture.entryId)
            assertEquals(1, check.signatureFormat)
            assertEquals(true, check.contentMatches, "a signature made before the migration verifies after it")
        } finally {
            pool.close()
            dsl.execute("""drop database "$scratch" with (force)""")
        }
    }
}
