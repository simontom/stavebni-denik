package cz.stavebni.denik.services

import cz.stavebni.denik.domain.AuditWriteException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

/** Which project an audit row belongs to: the rule that fills `audit_log.project_id`, which is part of the row hash. */
class AuditProjectTest {

    private val project = UUID.fromString("01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0e")
    private val other = UUID.fromString("01926c1e-3a54-7b2a-9d4e-5f6a7b8c9d0f")

    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)
    private fun snapshot(projectId: Any?) = json("""{"id":"x","projectId":${projectId?.let { "\"$it\"" } ?: "null"}}""")

    @Test
    fun `a user belongs to no project, whatever the snapshot says`() {
        assertNull(AuditProject.of("user", "11111111-1111-1111-1111-111111111111", null, json("""{"role":"BOSS"}""")))
        assertNull(AuditProject.of("user", "11111111-1111-1111-1111-111111111111", json("""{"role":"BOSS"}"""), null))
        assertNull(AuditProject.of("user", "x", null, snapshot(project)), "users are global: a project named in a snapshot does not make the row the project's")
    }

    @Test
    fun `the rows of a project (members, site manager, identification) are named by the entity, which is the project`() {
        assertEquals(project, AuditProject.of("project", project.toString(), null, json("""{"id":"$project"}""")))
        assertEquals(project, AuditProject.of("project", project.toString(), json("""{"userId":"u","role":"BOSS"}"""), null), "a member's removal has only a before")
        assertEquals(project, AuditProject.of("project", project.toString(), null, null))
    }

    @Test
    fun `entries, photos, handovers and authorised persons are named by the project in their snapshot`() {
        for (type in listOf("report", "photo", "siteHandover", "authorizedPerson")) {
            assertEquals(project, AuditProject.of(type, "entity", null, snapshot(project)), "$type: a creation has an after only")
            assertEquals(project, AuditProject.of(type, "entity", snapshot(project), null), "$type: a removal has a before only")
            assertEquals(project, AuditProject.of(type, "entity", snapshot(project), snapshot(project)), "$type: a change has both")
        }
    }

    @Test
    fun `a project id is read as a UUID, in any case`() {
        assertEquals(project, AuditProject.of("report", "r", null, snapshot(project.toString().uppercase())))
    }

    @Test
    fun `a row that cannot be given a project is refused`() {
        val noProject = assertThrows<AuditWriteException> { AuditProject.of("report", "r", null, json("""{"id":"x"}""")) }
        assertTrue(noProject.message!!.contains("report"), noProject.message)
        assertThrows<AuditWriteException> { AuditProject.of("report", "r", null, null) }
        assertThrows<AuditWriteException> { AuditProject.of("photo", "p", null, snapshot(null)) }
        assertThrows<AuditWriteException> { AuditProject.of("photo", "p", null, json("""{"projectId":42}""")) }
        assertThrows<AuditWriteException> { AuditProject.of("photo", "p", null, json("""{"projectId":"not-a-uuid"}""")) }
        assertThrows<AuditWriteException> { AuditProject.of("photo", "p", null, json("""{"projectId":""}""")) }
        assertThrows<AuditWriteException> { AuditProject.of("photo", "p", null, json("""["$project"]""")) }
        assertThrows<AuditWriteException> { AuditProject.of("project", "123", null, null) }
        assertThrows<AuditWriteException> { AuditProject.of("project", "", null, null) }
    }

    @Test
    fun `a change that names two different projects is refused`() {
        val error = assertThrows<AuditWriteException> { AuditProject.of("report", "r", snapshot(project), snapshot(other)) }
        assertTrue(error.message!!.contains("two different projects"), error.message)
    }

    @Test
    fun `the project is read from a stored payload by the very same rule that fills it when the row is written`() {
        val ts = java.time.OffsetDateTime.parse("2026-10-18T09:31:00Z")
        fun payload(type: String, id: String, before: JsonElement?, after: JsonElement?) =
            AuditHash.payloadV2("x.y", null, type, id, before, after, ts)

        assertEquals(project, AuditProject.ofPayload(payload("report", "r", snapshot(project), snapshot(project))))
        assertEquals(project, AuditProject.ofPayload(payload("photo", "p", null, snapshot(project))))
        assertEquals(project, AuditProject.ofPayload(payload("project", project.toString(), null, json("""{"userId":"u"}"""))))
        assertNull(AuditProject.ofPayload(payload("user", "u", null, snapshot(project))))
        // What cannot be derived is refused, whatever the payload says elsewhere.
        assertThrows<AuditWriteException> { AuditProject.ofPayload(payload("invoice", "1", null, snapshot(project))) }
        assertThrows<AuditWriteException> { AuditProject.ofPayload(payload("report", "r", snapshot(project), snapshot(other))) }
        assertThrows<AuditWriteException> { AuditProject.ofPayload("not json") }
        assertThrows<AuditWriteException> { AuditProject.ofPayload("""{"entityType":"user"}""") }
    }

    @Test
    fun `an action has to start with its entity type, so that the type cannot be chosen to hide a row of a project`() {
        for ((type, action) in listOf(
            "report" to "report.update", "project" to "project.member.add", "photo" to "photo.upload", "siteHandover" to "siteHandover.sign",
            "authorizedPerson" to "authorizedPerson.revoke", "user" to "user.activate", "user" to "user.password_reset",
        )) {
            AuditProject.requireActionOf(type, action)
        }
        // A row about an entry that says it is a user's would belong to no project, in every export.
        assertThrows<AuditWriteException> { AuditProject.requireActionOf("user", "report.update") }
        assertThrows<AuditWriteException> { AuditProject.requireActionOf("user", "project.member.add") }
        assertThrows<AuditWriteException> { AuditProject.requireActionOf("report", "user.update") }
        assertThrows<AuditWriteException> { AuditProject.requireActionOf("report", "reports.update") }
        assertThrows<AuditWriteException> { AuditProject.requireActionOf("report", "report") }
        assertThrows<AuditWriteException> { AuditProject.requireActionOf("report", "Report.update") }
    }

    @Test
    fun `a refusal says what is wrong and nothing of the row`() {
        val secret = "Tajný zápis č. 7"
        val error = assertThrows<AuditWriteException> {
            AuditProject.of("report", "r", null, json("""{"note":"$secret","projectId":"not-a-uuid"}"""))
        }
        assertTrue(!error.message!!.contains(secret) && !error.message!!.contains("not-a-uuid"), error.message)
    }

    @Test
    fun `an entity type that has no rule is refused, so that a new kind of row cannot silently belong to no project`() {
        val error = assertThrows<AuditWriteException> { AuditProject.of("invoice", "1", null, snapshot(project)) }
        assertTrue(error.message!!.contains("invoice"), error.message)
    }
}
