package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import cz.stavebni.denik.jooq.tables.references.USERS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/**
 * What a person types into the fields of a user and of an authorised person is bounded: exactly the limit passes, one
 * character more is a `400` with a Czech message and changes nothing (before, the 256 KiB body limit was the only bound).
 */
class TextLimitsRoutesTest : BaseIntegrationTest() {

    private val admin: SessionUser by lazy { createTestUser(nickname = "the_admin", role = Role.BOSS, isAdmin = true) }

    private suspend fun ApplicationTestBuilder.send(method: HttpMethod, path: String, user: SessionUser, body: String): HttpResponse =
        client.request(path) {
            this.method = method
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private fun json(vararg fields: Pair<String, String>) = buildJsonObject { fields.forEach { (k, v) -> put(k, v) } }.toString()

    private suspend fun ApplicationTestBuilder.createUser(nickname: String, vararg fields: Pair<String, String>) =
        send(HttpMethod.Post, "/api/users", admin, json("nickname" to nickname, *fields))

    private suspend fun ApplicationTestBuilder.patchUser(id: UUID, vararg fields: Pair<String, String>) =
        send(HttpMethod.Patch, "/api/users/$id", admin, json(*fields))

    private fun user(nickname: String) = dsl.selectFrom(USERS).where(USERS.NICKNAME.eq(nickname)).fetchOne()

    /**
     * [request] is answered with 400 and a message that contains [expected], and writes no audit row of any kind: the number of
     * rows is taken before the request and has to be the same after it.
     */
    private suspend fun assertRefused(expected: String, request: suspend () -> HttpResponse) {
        val rowsBefore = dsl.fetchCount(AUDIT_LOG)
        val response = request()
        val body = response.bodyAsText()
        assertEquals(HttpStatusCode.BadRequest, response.status, body)
        assertTrue(body.contains(expected), "expected '$expected' in: $body")
        assertEquals(rowsBefore, dsl.fetchCount(AUDIT_LOG), "a refused request writes no audit row")
    }

    // ------------------------------------------------------------------------------ display name

    @Test
    fun `a display name of exactly 200 characters is accepted, 201 is refused and creates nothing`() = testApplication {
        application { module() }

        val ok = createUser("name.limit", "displayName" to "Č".repeat(200))
        assertEquals(HttpStatusCode.Created, ok.status, ok.bodyAsText())
        assertEquals(200, user("name.limit")!!.displayname!!.length)

        assertRefused("Jméno a příjmení může mít nejvýše 200 znaků") { createUser("name.too.long", "displayName" to "Č".repeat(201)) }
        assertNull(user("name.too.long"), "nothing was created")
    }

    @Test
    fun `characters are counted as a person counts them, an emoji is one`() = testApplication {
        application { module() }
        val emoji = "😀" // U+1F600: one character, two UTF-16 code units

        val ok = createUser("name.emoji", "displayName" to emoji.repeat(200))
        assertEquals(HttpStatusCode.Created, ok.status, ok.bodyAsText())
        assertEquals(emoji.repeat(200), user("name.emoji")!!.displayname, "200 characters, although 400 UTF-16 code units, are stored whole")

        assertRefused("Jméno a příjmení může mít nejvýše 200 znaků") { createUser("name.emoji.long", "displayName" to emoji.repeat(201)) }
        assertNull(user("name.emoji.long"))
    }

    @Test
    fun `the display name is trimmed before it is measured, and a blank one is still refused`() = testApplication {
        application { module() }

        val padded = createUser("name.padded", "displayName" to "  " + "a".repeat(200) + "  ")
        assertEquals(HttpStatusCode.Created, padded.status, padded.bodyAsText())
        assertEquals("a".repeat(200), user("name.padded")!!.displayname)

        assertRefused("Jméno a příjmení je povinné") { createUser("name.blank", "displayName" to "   ") }
    }

    @Test
    fun `editing a display name has the same limit and a refused edit changes nothing`() = testApplication {
        application { module() }
        val target = createTestUser(nickname = "edit.name", displayName = "Původní jméno", role = Role.WORKER)

        val ok = patchUser(target.id, "displayName" to "ž".repeat(200))
        assertEquals(HttpStatusCode.OK, ok.status, ok.bodyAsText())
        assertEquals("ž".repeat(200), user("edit.name")!!.displayname)

        assertRefused("Jméno a příjmení může mít nejvýše 200 znaků") { patchUser(target.id, "displayName" to "ž".repeat(201)) }
        assertEquals("ž".repeat(200), user("edit.name")!!.displayname, "the stored name is unchanged")

        assertRefused("Jméno a příjmení je povinné") { patchUser(target.id, "displayName" to "  ") }
    }

    @Test
    fun `a NUL character in a display name is a 400 with a message`() = testApplication {
        application { module() }

        assertRefused("nepovolený znak") { createUser("name.nul", "displayName" to "Jan\u0000Novák") }
        assertNull(user("name.nul"))
    }

    // ------------------------------------------------------------------------------ ČKAIT number

    @Test
    fun `a ckait number of exactly 50 characters is accepted, 51 is refused`() = testApplication {
        application { module() }

        val ok = createUser("ckait.limit", "displayName" to "Autorizovaná osoba", "ckaitNumber" to "1".repeat(50))
        assertEquals(HttpStatusCode.Created, ok.status, ok.bodyAsText())
        assertEquals("1".repeat(50), user("ckait.limit")!!.ckaitnumber)

        assertRefused("Číslo ČKAIT může mít nejvýše 50 znaků") { createUser("ckait.too.long", "displayName" to "Autorizovaná osoba", "ckaitNumber" to "1".repeat(51)) }
        assertNull(user("ckait.too.long"))
    }

    @Test
    fun `the ckait number is trimmed before it is measured and a blank one is no number`() = testApplication {
        application { module() }

        val padded = createUser("ckait.padded", "displayName" to "Autorizovaná osoba", "ckaitNumber" to "  " + "7".repeat(50) + " ")
        assertEquals(HttpStatusCode.Created, padded.status, padded.bodyAsText())
        assertEquals("7".repeat(50), user("ckait.padded")!!.ckaitnumber)

        val blank = createUser("ckait.blank", "displayName" to "Bez čísla", "ckaitNumber" to "   ")
        assertEquals(HttpStatusCode.Created, blank.status, blank.bodyAsText())
        assertNull(user("ckait.blank")!!.ckaitnumber)
    }

    @Test
    fun `editing the ckait number has the same limit, and clearing it still works`() = testApplication {
        application { module() }
        val target = createTestUser(nickname = "edit.ckait", role = Role.WORKER, ckaitNumber = "0001")

        val ok = patchUser(target.id, "ckaitNumber" to "9".repeat(50))
        assertEquals(HttpStatusCode.OK, ok.status, ok.bodyAsText())
        assertEquals("9".repeat(50), user("edit.ckait")!!.ckaitnumber)

        assertRefused("Číslo ČKAIT může mít nejvýše 50 znaků") { patchUser(target.id, "ckaitNumber" to "9".repeat(51)) }
        assertEquals("9".repeat(50), user("edit.ckait")!!.ckaitnumber, "the stored number is unchanged")

        val cleared = patchUser(target.id, "ckaitNumber" to "  ")
        assertEquals(HttpStatusCode.OK, cleared.status, cleared.bodyAsText())
        assertNull(user("edit.ckait")!!.ckaitnumber)
    }

    // ------------------------------------------------------------------------------ authorised persons

    private val manager: SessionUser by lazy { createTestUser(nickname = "the_manager", role = Role.BOSS) }

    private val projectId: UUID by lazy {
        runBlocking {
            UUID.fromString(
                ProjectService.createProject(
                    manager,
                    ProjectDto(
                        id = "", name = "Limits", address = "Address", cadastralArea = "Area",
                        parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = manager.id.toString(),
                    ),
                ).id,
            )
        }
    }

    private suspend fun ApplicationTestBuilder.addPerson(vararg fields: Pair<String, String>) =
        send(HttpMethod.Post, "/api/projects/$projectId/authorized-persons", manager, json(*fields))

    private fun persons() = dsl.selectFrom(AUTHORIZED_PERSONS).fetch()

    @Test
    fun `the name of an authorised person may have 200 characters, 201 is refused`() = testApplication {
        application { module() }

        val ok = addPerson("name" to "N".repeat(200))
        assertEquals(HttpStatusCode.Created, ok.status, ok.bodyAsText())
        assertEquals(1, persons().size)

        assertRefused("Jméno pověřené osoby může mít nejvýše 200 znaků") { addPerson("name" to "N".repeat(201)) }
        assertEquals(1, persons().size, "nothing was added")
    }

    @Test
    fun `the company of an authorised person may have 200 characters, 201 is refused`() = testApplication {
        application { module() }

        val ok = addPerson("name" to "Ing. Dozor", "company" to "C".repeat(200))
        assertEquals(HttpStatusCode.Created, ok.status, ok.bodyAsText())

        assertRefused("Organizace může mít nejvýše 200 znaků") { addPerson("name" to "Ing. Dozor", "company" to "C".repeat(201)) }
        assertEquals(1, persons().size)
    }

    @Test
    fun `the scope of the authorisation may have 500 characters, 501 is refused`() = testApplication {
        application { module() }

        val ok = addPerson("name" to "Ing. Dozor", "authorization" to "A".repeat(500))
        assertEquals(HttpStatusCode.Created, ok.status, ok.bodyAsText())
        assertEquals(500, persons().single().authorization!!.length)

        assertRefused("Rozsah pověření / Funkce může mít nejvýše 500 znaků") { addPerson("name" to "Ing. Dozor", "authorization" to "A".repeat(501)) }
        assertEquals(1, persons().size)
    }

    @Test
    fun `the fields of an authorised person are trimmed before they are measured, blanks stay what they were`() = testApplication {
        application { module() }

        val padded = addPerson(
            "name" to " " + "n".repeat(200) + " ", "company" to " " + "c".repeat(200) + " ", "authorization" to " " + "a".repeat(500) + " ",
        )
        assertEquals(HttpStatusCode.Created, padded.status, padded.bodyAsText())
        val stored = persons().single()
        assertEquals("n".repeat(200), stored.name)
        assertEquals("c".repeat(200), stored.company)
        assertEquals("a".repeat(500), stored.authorization)

        assertRefused("Jméno pověřené osoby je povinné") { addPerson("name" to "   ") }

        val blankRest = addPerson("name" to "Karel", "company" to "  ", "authorization" to "")
        assertEquals(HttpStatusCode.Created, blankRest.status, blankRest.bodyAsText())
        val karel = persons().first { it.name == "Karel" }
        assertNull(karel.company)
        assertNull(karel.authorization)
    }

    @Test
    fun `a NUL character in a field of an authorised person is a 400 with a message`() = testApplication {
        application { module() }
        check(projectId.toString().isNotEmpty()) // the project (and its audit row) is made lazily: before the rows are counted, not by the refused request

        assertRefused("nepovolený znak") { addPerson("name" to "Karel\u0000", "company" to "Firma") }
        assertEquals(0, persons().size)
    }
}
