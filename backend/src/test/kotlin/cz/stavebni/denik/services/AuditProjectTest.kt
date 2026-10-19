package cz.stavebni.denik.services

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
        val noProject = assertThrows<IllegalStateException> { AuditProject.of("report", "r", null, json("""{"id":"x"}""")) }
        assertTrue(noProject.message!!.contains("report"), noProject.message)
        assertThrows<IllegalStateException> { AuditProject.of("report", "r", null, null) }
        assertThrows<IllegalStateException> { AuditProject.of("photo", "p", null, snapshot(null)) }
        assertThrows<IllegalStateException> { AuditProject.of("photo", "p", null, json("""{"projectId":42}""")) }
        assertThrows<IllegalStateException> { AuditProject.of("photo", "p", null, json("""{"projectId":"not-a-uuid"}""")) }
        assertThrows<IllegalStateException> { AuditProject.of("photo", "p", null, json("""{"projectId":""}""")) }
        assertThrows<IllegalStateException> { AuditProject.of("photo", "p", null, json("""["$project"]""")) }
        assertThrows<IllegalStateException> { AuditProject.of("project", "123", null, null) }
        assertThrows<IllegalStateException> { AuditProject.of("project", "", null, null) }
    }

    @Test
    fun `a change that names two different projects is refused`() {
        val error = assertThrows<IllegalStateException> { AuditProject.of("report", "r", snapshot(project), snapshot(other)) }
        assertTrue(error.message!!.contains("two different projects"), error.message)
    }

    @Test
    fun `an entity type that has no rule is refused, so that a new kind of row cannot silently belong to no project`() {
        val error = assertThrows<IllegalStateException> { AuditProject.of("invoice", "1", null, snapshot(project)) }
        assertTrue(error.message!!.contains("invoice"), error.message)
    }
}
