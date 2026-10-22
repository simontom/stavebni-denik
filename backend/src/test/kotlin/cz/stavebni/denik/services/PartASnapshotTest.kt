package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ConflictException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUTHORIZED_PERSONS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import cz.stavebni.denik.jooq.tables.references.USERS
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.OffsetDateTime
import java.util.UUID

/**
 * The identification of the diary as signature format 3 freezes it (`PartASnapshot`): what it holds, in which order, which
 * persons are in it, how large it can be, and that a column added later cannot slip past it unnoticed.
 */
class PartASnapshotTest : BaseIntegrationTest() {

    private suspend fun project(boss: SessionUser, extra: (ProjectDto) -> ProjectDto = { it }): UUID =
        UUID.fromString(
            ProjectService.createProject(
                boss,
                extra(
                    ProjectDto(
                        id = "", name = "Bytový dům Zelená", address = "Zelená 1, Brno", cadastralArea = "Brno-střed", parcelNumbers = "12/3, 12/4",
                        builder = "Stavebník a.s.", contractor = "Zhotovitel s.r.o.", siteManagerId = boss.id.toString(),
                        permitNumber = "SZ/2026/123", permitDate = "2026-03-15", tdsName = "Ing. Karel TDS", bozpName = "Eva BOZP",
                        designerName = "Projekt s.r.o.", authorSupervisionName = "Ing. arch. Petr Dozor",
                        authorSupervisionAuthorization = "ČKA 00 123", contractNumber = "SML-1", contractDate = "2026-04-01",
                        designDocVersion = "v1.2", designDocDate = "2026-02-02", subcontractors = "Elektro s.r.o.\nVoda a.s.",
                        supportingDocuments = "Smlouva o dílo\nStavební povolení",
                    ),
                ),
            ).id,
        )

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test
    fun `the snapshot holds the identification, the site manager, the persons with a role and the active authorized persons`() = runBlocking<Unit> {
        val boss = createTestUser(nickname = "boss", displayName = "  Jan Stavbyvedoucí ", role = Role.BOSS, ckaitNumber = " 0012345 ")
        val projectId = project(boss)

        val snapshot = json(PartASnapshot.build(dsl, projectId))

        assertEquals(setOf("authorizedPersons", "identification", "members", "projectId", "siteManager"), snapshot.keys)
        assertEquals(projectId.toString(), snapshot["projectId"]!!.jsonPrimitive.content)
        val identification = snapshot["identification"]!!.jsonObject
        assertEquals("Bytový dům Zelená", identification["name"]!!.jsonPrimitive.content)
        assertEquals("Ing. arch. Petr Dozor", identification["authorSupervisionName"]!!.jsonPrimitive.content)
        assertEquals("ČKA 00 123", identification["authorSupervisionAuthorization"]!!.jsonPrimitive.content)
        // A calendar day is written as a day, whatever time zone the database or the machine is in.
        assertEquals("2026-03-15", identification["permitDate"]!!.jsonPrimitive.content)
        assertEquals("Elektro s.r.o.\nVoda a.s.", identification["subcontractors"]!!.jsonPrimitive.content)
        val siteManager = snapshot["siteManager"]!!.jsonObject
        assertEquals(boss.id.toString(), siteManager["userId"]!!.jsonPrimitive.content)
        assertEquals("Jan Stavbyvedoucí", siteManager["name"]!!.jsonPrimitive.content, "the name as people write it: trimmed")
        assertEquals("0012345", siteManager["ckaitNumber"]!!.jsonPrimitive.content)
        // The creator and the site manager are BOSS members from the start.
        assertEquals(listOf(boss.id.toString()), snapshot["members"]!!.jsonArray.map { it.jsonObject["userId"]!!.jsonPrimitive.content })
        assertEquals(0, snapshot["authorizedPersons"]!!.jsonArray.size)
    }

    @Test
    fun `a field that says nothing is null, never left out`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss) { it.copy(permitNumber = null, permitDate = null, authorSupervisionName = null, authorSupervisionAuthorization = null, tdsName = null) }

        val identification = json(PartASnapshot.build(dsl, projectId))["identification"]!!.jsonObject

        for (key in listOf("permitNumber", "permitDate", "authorSupervisionName", "authorSupervisionAuthorization", "tdsName")) {
            assertEquals(JsonNull, identification[key], "$key is in the snapshot as null")
        }
        assertEquals(PartASnapshot.IDENTIFICATION_KEYS.toSet(), identification.keys, "every key of the identification is always there")
    }

    @Test
    fun `members are the BOSS and INSPECTOR ones, with their number and scope, oldest first, and nobody else`() = runBlocking<Unit> {
        val boss = createTestUser(nickname = "boss", displayName = "Jan Stavbyvedoucí", role = Role.BOSS)
        val projectId = project(boss)
        val deputy = createTestUser(nickname = "deputy", displayName = "Marie Zástupce", role = Role.BOSS, ckaitNumber = "0099999")
        val supervisor = createTestUser(nickname = "dozor", displayName = "Ing. Dozor", role = Role.INSPECTOR, ckaitNumber = null)
        val worker = createTestUser(nickname = "worker", displayName = "Pavel Dělník", role = Role.WORKER)
        val investor = createTestUser(nickname = "investor", displayName = "Investor", role = Role.INVESTOR)
        val gone = createTestUser(nickname = "gone", displayName = "Smazaný", role = Role.INSPECTOR)
        val base = OffsetDateTime.parse("2026-01-01T10:00:00Z")
        for ((index, entry) in listOf(deputy to Role.BOSS, supervisor to Role.INSPECTOR, worker to Role.WORKER, investor to Role.INVESTOR, gone to Role.INSPECTOR).withIndex()) {
            addMember(projectId, entry.first, entry.second)
            dsl.update(PROJECT_MEMBERS).set(PROJECT_MEMBERS.ADDEDAT, base.plusMinutes(index.toLong() + 1))
                .where(PROJECT_MEMBERS.USERID.eq(entry.first.id)).execute()
        }
        dsl.update(PROJECT_MEMBERS).set(PROJECT_MEMBERS.ADDEDAT, base).where(PROJECT_MEMBERS.USERID.eq(boss.id)).execute()
        dsl.update(PROJECT_MEMBERS).set(PROJECT_MEMBERS.SCOPE, "Celé dílo, vedení stavby").where(PROJECT_MEMBERS.USERID.eq(boss.id)).execute()
        dsl.update(PROJECT_MEMBERS).set(PROJECT_MEMBERS.SCOPE, "Technický dozor stavebníka").where(PROJECT_MEMBERS.USERID.eq(supervisor.id)).execute()
        dsl.update(USERS).set(USERS.DELETEDAT, OffsetDateTime.now()).where(USERS.ID.eq(gone.id)).execute()

        val members = json(PartASnapshot.build(dsl, projectId))["members"]!!.jsonArray.map { it.jsonObject }

        assertEquals(listOf("Jan Stavbyvedoucí", "Marie Zástupce", "Ing. Dozor"), members.map { it["name"]!!.jsonPrimitive.content })
        assertEquals(listOf("BOSS", "BOSS", "INSPECTOR"), members.map { it["role"]!!.jsonPrimitive.content })
        assertEquals(listOf("0012345", "0099999"), members.take(2).map { it["ckaitNumber"]!!.jsonPrimitive.content })
        assertEquals(JsonNull, members[2]["ckaitNumber"], "an inspector may have no number")
        assertEquals("Celé dílo, vedení stavby", members[0]["scope"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, members[1]["scope"])
        assertEquals("Technický dozor stavebníka", members[2]["scope"]!!.jsonPrimitive.content)
        assertEquals(setOf("ckaitNumber", "name", "role", "scope", "userId"), members[0].keys)
    }

    @Test
    fun `only the authorized persons who are active at that moment are in the snapshot`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val first = AuthorizedPersonService.create(boss, projectId, CreateAuthorizedPersonRequest("Ing. Arch. Petr Černý", "Architekti s.r.o.", "Autorský dozor projektanta"))
        val second = AuthorizedPersonService.create(boss, projectId, CreateAuthorizedPersonRequest("Eva Koordinátorka", null, "Koordinátor BOZP"))
        AuthorizedPersonService.revoke(boss, UUID.fromString(first.id))

        val persons = json(PartASnapshot.build(dsl, projectId))["authorizedPersons"]!!.jsonArray.map { it.jsonObject }

        assertEquals(listOf(second.id), persons.map { it["id"]!!.jsonPrimitive.content }, "a revoked person is no longer one of the persons who may make entries")
        assertEquals("Koordinátor BOZP", persons.single()["authorization"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, persons.single()["company"])
        assertEquals(setOf("authorization", "company", "id", "name"), persons.single().keys)
    }

    @Test
    fun `the text is canonical, with sorted keys and compact, and the same for the same data`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)

        val text = PartASnapshot.build(dsl, projectId)

        assertEquals(text, PartASnapshot.build(dsl, projectId), "building it again gives the same bytes")
        assertEquals(text, AuditHash.canonicalJson(Json.parseToJsonElement(text)), "it is what the canonical writer makes of itself")
        // A line break inside a text is written as \n, so there is none in the text itself.
        assertFalse(text.contains('\n'), "compact")
        assertTrue(text.startsWith("""{"authorizedPersons":[],"identification":{"address":"""), text.take(80))
    }

    @Test
    fun `the text of a snapshot is read back into the same data`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        val supervisor = createTestUser(role = Role.INSPECTOR, displayName = "Ing. Dozor")
        addMember(projectId, supervisor, Role.INSPECTOR)

        val text = PartASnapshot.build(dsl, projectId)
        val parsed = PartASnapshot.parse(text)

        assertEquals(projectId.toString(), parsed.projectId)
        assertEquals(text, PartASnapshot.textOf(parsed), "reading and writing again changes nothing")
        assertEquals(listOf("BOSS", "INSPECTOR"), parsed.members.map { it.role })
        assertEquals(boss.id.toString(), parsed.siteManager.userId)
    }

    // --- how large it can be ---------------------------------------------------------------------

    @Test
    fun `a snapshot larger than the limit is refused, with a message, before it is stored`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        // Data that did not come through the application (its limits are 5 000 characters): one megabyte and more.
        dsl.update(PROJECTS).set(PROJECTS.SUPPORTINGDOCUMENTS, "x".repeat(PartASnapshot.MAX_BYTES)).where(PROJECTS.ID.eq(projectId)).execute()

        val refused = assertThrows<ConflictException> { PartASnapshot.build(dsl, projectId) }

        assertTrue(refused.message!!.contains("příliš rozsáhlé"), refused.message)
    }

    @Test
    fun `the limit counts bytes, not characters`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        // 400 000 characters of four bytes each (an emoji): 1.6 MB, over the limit although under it in characters.
        dsl.update(PROJECTS).set(PROJECTS.SUPPORTINGDOCUMENTS, "😀".repeat(400_000)).where(PROJECTS.ID.eq(projectId)).execute()

        assertThrows<ConflictException> { PartASnapshot.build(dsl, projectId) }
    }

    @Test
    fun `the number of persons is limited before they are read`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        // Direct inserts: the application refuses the 101st (ProjectMemberService, AuthorizedPersonService), this is the last line.
        repeat(PartASnapshot.MAX_PERSONS) { n ->
            dsl.insertInto(AUTHORIZED_PERSONS).set(AUTHORIZED_PERSONS.PROJECTID, projectId).set(AUTHORIZED_PERSONS.NAME, "Osoba $n").execute()
        }
        PartASnapshot.build(dsl, projectId)

        dsl.insertInto(AUTHORIZED_PERSONS).set(AUTHORIZED_PERSONS.PROJECTID, projectId).set(AUTHORIZED_PERSONS.NAME, "Jedna navíc").execute()

        assertThrows<ConflictException> { PartASnapshot.build(dsl, projectId) }
    }

    // --- what the live view is ---------------------------------------------------------------------

    @Test
    fun `the live view is the same data, without the limit (a document can always be printed)`() = runBlocking<Unit> {
        val boss = createTestUser(role = Role.BOSS)
        val projectId = project(boss)
        dsl.update(PROJECTS).set(PROJECTS.SUPPORTINGDOCUMENTS, "x".repeat(PartASnapshot.MAX_BYTES)).where(PROJECTS.ID.eq(projectId)).execute()

        val live = PartASnapshot.read(dsl, projectId)

        assertEquals(projectId.toString(), live.projectId)
        assertEquals(PartASnapshot.MAX_BYTES, live.identification["supportingDocuments"]!!.length)
    }

    // --- a field added later must be a decision, not an accident -----------------------------------

    /** The columns that are not part A, and why; any other column of the project has to be in the snapshot (format 3). */
    private val notPartAOfProject = mapOf(
        "id" to "the project's id is `projectId` of the snapshot",
        "siteManagerId" to "the site manager is `siteManager` of the snapshot",
        "gpsLat" to "unused", "gpsLon" to "unused", "startedAt" to "unused", "endedAt" to "unused",
        "createdAt" to "bookkeeping", "updatedAt" to "bookkeeping", "createdById" to "bookkeeping", "deletedAt" to "bookkeeping",
    )

    @Test
    fun `a column added to the project is either part A in a new format or listed here as not part A`() {
        val columns = PROJECTS.fields().map { it.name }.toSet()
        val covered = PartASnapshot.IDENTIFICATION_KEYS.toSet() + notPartAOfProject.keys
        assertEquals(
            emptySet<String>(), columns - covered,
            "A column was added to projects. Signature format 3 covers a frozen list of fields of part A (PartASnapshot.IDENTIFICATION_KEYS): " +
                "a column that is part A needs a format 4, one that is not is added to notPartAOfProject in this test with its reason.",
        )
        assertEquals(emptySet<String>(), PartASnapshot.IDENTIFICATION_KEYS.toSet() - columns, "a key of the snapshot names no column")
    }

    @Test
    fun `the keys of the identification are frozen with format 3`() {
        assertEquals(
            listOf(
                "name", "address", "cadastralArea", "parcelNumbers", "builder", "contractor", "permitNumber", "permitDate", "designerName",
                "authorSupervisionName", "authorSupervisionAuthorization", "tdsName", "bozpName", "contractNumber", "contractDate",
                "designDocVersion", "designDocDate", "subcontractors", "supportingDocuments",
            ),
            PartASnapshot.IDENTIFICATION_KEYS,
            "signature format 3 is frozen: its keys can never change",
        )
    }

    @Test
    fun `a column added to a membership, an authorized person or a user is a decision too`() {
        assertEquals(
            setOf("projectId", "userId", "role", "scope", "addedAt", "addedById"), PROJECT_MEMBERS.fields().map { it.name }.toSet(),
            "A column was added to project_members. Part A of format 3 holds userId, role and scope of a member (and the name and number of the user): a new column that belongs there needs a format 4.",
        )
        assertEquals(
            setOf("id", "projectId", "linkedUserId", "name", "company", "authorization", "revokedAt", "createdAt", "updatedAt"), AUTHORIZED_PERSONS.fields().map { it.name }.toSet(),
            "A column was added to authorized_persons. Part A of format 3 holds id, name, company and authorization of an active person: a new column that belongs there needs a format 4.",
        )
    }
}
