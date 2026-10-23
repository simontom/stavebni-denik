package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.MeterState
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.SITE_HANDOVERS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/**
 * The lines of a protocol are limited as well as its characters (backlog B9, review): a newline costs one character, so a text of a few
 * thousand characters could be thousands of printed lines, and the project's protocols are printed in the PDF of every entry. The type
 * and the fields of a meter are one line, the participants have at most [SiteHandoverService.MAX_PARTICIPANTS_LINES] lines and the notes
 * at most [SiteHandoverService.MAX_NOTES_LINES]. A line ends where the printed document ends it (`Text.lineCount`).
 */
class HandoverLinesTest : BaseIntegrationTest() {

    private class Site(val projectId: UUID, val boss: SessionUser)

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Lines", address = "Address", cadastralArea = "Area", parcelNumbers = "1",
                builder = "Builder", contractor = "Contractor", siteManagerId = boss.id.toString(),
            ),
        )
        return Site(UUID.fromString(project.id), boss)
    }

    private fun lines(count: Int, separator: String = "\n") = (1..count).joinToString(separator) { "řádek $it" }

    private fun create(s: Site, input: SiteHandoverInput) = runBlocking { SiteHandoverService.createHandover(s.boss, s.projectId, input) }

    private fun refused(s: Site, what: String, input: SiteHandoverInput, expected: String): String {
        val failure = assertThrows<IllegalArgumentException>(what) { create(s, input) }
        assertTrue(failure.message!!.contains(expected), "$what: ${failure.message}")
        return failure.message!!
    }

    @Test
    fun `the type and the fields of a meter are one line, whatever ends the line`() = runBlocking<Unit> {
        val s = site()
        for ((name, separator) in listOf("LF" to "\n", "CR" to "\r", "CRLF" to "\r\n", "vertical tab" to "\u000B", "form feed" to "\u000C", "next line" to "\u0085", "line separator" to " ", "paragraph separator" to " ")) {
            refused(s, "the type, $name", handoverInput(type = "Předání${separator}staveniště"), "na jeden řádek")
            refused(s, "a medium, $name", handoverInput(meterStates = listOf(MeterState("Voda${separator}studená", "V-1", "3 m3"))), "na jeden řádek")
            refused(s, "a serial number, $name", handoverInput(meterStates = listOf(MeterState("Voda", "V${separator}1", "3 m3"))), "na jeden řádek")
            refused(s, "a state, $name", handoverInput(meterStates = listOf(MeterState("Voda", "V-1", "3${separator}m3"))), "na jeden řádek")
        }
        assertEquals(0, dsl.fetchCount(SITE_HANDOVERS), "nothing of a refused protocol is stored")
        // A line that is only long is not refused here (its length is limited in characters).
        assertEquals(200, create(s, handoverInput(type = "Předání staveniště ".repeat(12).take(200).trim().padEnd(200, 'x'))).type.length)
    }

    @Test
    fun `the participants have at most 100 lines and the notes at most 200, and the message says so`() = runBlocking<Unit> {
        val s = site()

        assertEquals(100, LineCount.count(create(s, handoverInput(participants = lines(100))).participants))
        val participants = refused(s, "101 lines of participants", handoverInput(participants = lines(101)), "100 řádků")
        assertTrue(participants.contains("Účastníci"), participants)
        assertEquals(200, LineCount.count(create(s, handoverInput(notes = lines(200))).notes!!))
        val notes = refused(s, "201 lines of notes", handoverInput(notes = lines(201)), "200 řádků")
        assertTrue(notes.contains("Poznámky"), notes)
        // The characters are limited as before: the limit of the lines does not allow more of them.
        refused(s, "the characters of the notes", handoverInput(notes = "n".repeat(5001)), "5000 znaků")
    }

    @Test
    fun `lines are counted the way the printed document ends them, a CRLF is one break and blank lines count`() = runBlocking<Unit> {
        val s = site()

        // 100 lines separated by CRLF: 99 breaks of two characters each, not 198 lines.
        assertEquals(100, LineCount.count(create(s, handoverInput(participants = lines(100, "\r\n"))).participants))
        refused(s, "101 lines with CRLF", handoverInput(participants = lines(101, "\r\n")), "100 řádků")
        refused(s, "101 lines with CR", handoverInput(participants = lines(101, "\r")), "100 řádků")
        refused(s, "101 lines with the line separator of Unicode", handoverInput(participants = lines(101, " ")), "100 řádků")
        refused(s, "101 lines of which most are blank", handoverInput(participants = "a" + "\n".repeat(100) + "b"), "100 řádků")
        // A break at the end of the text is trimmed, like the rest of the white space, and is no line.
        assertEquals(100, LineCount.count(create(s, handoverInput(participants = lines(100) + "\n\n\n")).participants))
        // A thousand blank lines in a few thousand characters: what this limit exists for.
        refused(s, "a thousand blank lines", handoverInput(notes = "x" + "\n".repeat(1000) + "y"), "200 řádků")
    }

    @Test
    fun `a change of a protocol is held to the same limits`() = runBlocking<Unit> {
        val s = site()
        val created = create(s, handoverInput())

        val failure = assertThrows<IllegalArgumentException> {
            runBlocking { SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(participants = lines(101))) }
        }
        assertTrue(failure.message!!.contains("100 řádků"), failure.message)
        val typeFailure = assertThrows<IllegalArgumentException> {
            runBlocking { SiteHandoverService.updateHandover(s.boss, created.uuid, created.asInput(type = "a\nb")) }
        }
        assertTrue(typeFailure.message!!.contains("na jeden řádek"), typeFailure.message)
        assertEquals(created.participants, SiteHandoverService.getHandover(dsl, s.boss, created.uuid)!!.participants, "the protocol is as it was")
    }

    /** What the tests below call a line: the same count as the application's, written out so that a test of it cannot agree with a mistake of it. */
    private object LineCount {
        fun count(text: String): Int = text.split(Regex("\r\n|[\r\n\u000B\u000C\u0085  ]")).size
    }
}
