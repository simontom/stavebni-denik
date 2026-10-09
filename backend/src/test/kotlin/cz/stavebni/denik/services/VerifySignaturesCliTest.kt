package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.cli.AdminCli
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.PHOTOS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.UUID
import javax.imageio.ImageIO

/** `verify-signatures`: every signed entry and photo file hashed again; what a restore from a backup runs. */
class VerifySignaturesCliTest : BaseIntegrationTest() {

    private class Run(val code: Int, val out: List<String>, val err: List<String>)

    private fun cli(vararg args: String): Run {
        val out = mutableListOf<String>()
        val err = mutableListOf<String>()
        return Run(AdminCli.run(args.toList(), out::add, err::add), out, err)
    }

    private fun jpeg(): ByteArray = ByteArrayOutputStream().also { ImageIO.write(BufferedImage(120, 90, BufferedImage.TYPE_INT_RGB), "jpeg", it) }.toByteArray()

    private suspend fun signedEntryWithPhoto(): Pair<UUID, UUID> {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Verify", address = "A", cadastralArea = "C", parcelNumbers = "1",
                builder = "B", contractor = "C", siteManagerId = boss.id.toString(),
            )
        )
        val projectId = UUID.fromString(project.id)
        val report = UUID.fromString(DailyReportService.createReport(boss, projectId, "2026-09-28", workDescription = "Betonáž").id)
        val photo = PhotoService.uploadPhoto(boss, report, jpeg(), "image/jpeg", "a.jpg")
        DailyReportService.signReport(boss, report)
        return report to photo.id
    }

    @Test
    fun `an intact database verifies, also with nothing signed`() = runBlocking<Unit> {
        assertEquals(0, cli("verify-signatures").code, "an empty database has nothing to break")

        signedEntryWithPhoto()
        val run = cli("verify-signatures")

        assertEquals(0, run.code, run.err.toString())
        assertTrue(run.out.single().contains("1 signed entries"), run.out.toString())
    }

    @Test
    fun `a text changed behind the application's back is reported and exits 1`() = runBlocking<Unit> {
        val (report, _) = signedEntryWithPhoto()
        dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
        try {
            dsl.execute("""update daily_reports set "workDescription" = 'Zfalšováno' where id = ?""", report)
        } finally {
            dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
        }

        val run = cli("verify-signatures")

        assertEquals(1, run.code)
        assertTrue(run.err.any { it.contains(report.toString()) && it.contains("content") }, run.err.toString())
    }

    @Test
    fun `a photo file replaced on the volume is reported and exits 1`() = runBlocking<Unit> {
        val (report, photoId) = signedEntryWithPhoto()
        val key = dsl.select(PHOTOS.PATHORIGINAL).from(PHOTOS).where(PHOTOS.ID.eq(photoId)).fetchOne(PHOTOS.PATHORIGINAL)!!
        Files.write(PhotoStorage.resolve(key)!!, ByteArray(100) { 7 })

        val run = cli("verify-signatures")

        assertEquals(1, run.code)
        assertTrue(run.err.any { it.contains(report.toString()) && it.contains("photo") }, run.err.toString())
    }

    @Test
    fun `an entry signed before hashes existed is counted, not failed`() = runBlocking<Unit> {
        val (report, _) = signedEntryWithPhoto()
        dsl.execute("""ALTER TABLE "daily_reports" DISABLE TRIGGER USER""")
        try {
            dsl.execute("""update daily_reports set "signatureHash" = null where id = ?""", report)
        } finally {
            dsl.execute("""ALTER TABLE "daily_reports" ENABLE TRIGGER USER""")
        }

        val run = cli("verify-signatures")

        assertEquals(0, run.code, run.err.toString())
        assertTrue(run.out.single().contains("signed before hashes existed"), run.out.toString())
    }

    @Test
    fun `the command takes no arguments and only reads`() {
        assertTrue(AdminCli.hasValidShape(listOf("verify-signatures")))
        assertFalse(AdminCli.hasValidShape(listOf("verify-signatures", "x")))
        assertTrue(AdminCli.readsOnly(listOf("verify-signatures")))
    }
}
