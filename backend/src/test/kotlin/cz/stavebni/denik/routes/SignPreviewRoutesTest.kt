package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.DAILY_REPORTS
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.module
import cz.stavebni.denik.services.AddMemberRequest
import cz.stavebni.denik.services.AuthorizedPersonService
import cz.stavebni.denik.services.CreateAuthorizedPersonRequest
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.PartASnapshot
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectMemberService
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/**
 * The signer sees part A before signing (backlog C2b). `GET …/sign-preview` gives part A as signing would store it now and its
 * digest; the sign request names that digest (`expectedPartASha256`), and a part A that is different when the request is handled
 * is `409 STALE_VERSION` with nothing signed and nothing recorded.
 */
class SignPreviewRoutesTest : BaseIntegrationTest() {

    private class Site(val boss: SessionUser, val coManager: SessionUser, val worker: SessionUser, val projectId: UUID, val reportId: String)

    private suspend fun site(): Site {
        val boss = createTestUser(role = Role.BOSS, displayName = "Jan Stavbyvedoucí")
        val coManager = createTestUser(role = Role.BOSS, displayName = "Marie Zástupce", ckaitNumber = "0099999")
        val worker = createTestUser(role = Role.WORKER)
        val project = ProjectService.createProject(
            boss,
            ProjectDto(
                id = "", name = "Bytový dům Zelená", address = "Zelená 1, Brno", cadastralArea = "Brno-střed", parcelNumbers = "12/3",
                builder = "Stavebník a.s.", contractor = "Zhotovitel s.r.o.", siteManagerId = boss.id.toString(),
            ),
        )
        val projectId = UUID.fromString(project.id)
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(coManager.id.toString(), "BOSS"))
        ProjectMemberService.addMember(boss, projectId, AddMemberRequest(worker.id.toString(), "WORKER"))
        val report = DailyReportService.createReport(boss, projectId, "2026-09-29")
        return Site(boss, coManager, worker, projectId, report.id)
    }

    private suspend fun ApplicationTestBuilder.request(user: SessionUser, method: HttpMethod, path: String, body: String? = null): HttpResponse =
        client.request(path) {
            this.method = method
            header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}")
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private fun Site.projectPreview() = "/api/projects/$projectId/reports/$reportId/sign-preview"
    private fun Site.entryPreview() = "/api/reports/$reportId/sign-preview"
    private fun Site.projectSign() = "/api/projects/$projectId/reports/$reportId/sign"
    private fun Site.entrySign() = "/api/reports/$reportId/sign"

    private fun auditRows(): Int = dsl.fetchCount(AUDIT_LOG)

    private fun isSigned(reportId: String): Boolean =
        dsl.select(DAILY_REPORTS.LOCKEDAT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(reportId))).fetchOne(DAILY_REPORTS.LOCKEDAT) != null

    @Test
    fun `the preview is part A as signing then stores it, with the same digest, on both routes and by date`() = testApplication {
        application { module() }
        val s = site()
        AuthorizedPersonService.create(s.boss, s.projectId, CreateAuthorizedPersonRequest(name = "Ing. Dozor", company = "TDS s.r.o.", authorization = "Autorský dozor"))
        ProjectMemberService.addMember(s.boss, s.projectId, AddMemberRequest(s.coManager.id.toString(), "BOSS", scope = "Elektroinstalace"))
        val rowsBefore = auditRows()

        val byProject = request(s.boss, HttpMethod.Get, s.projectPreview())
        val byEntry = request(s.boss, HttpMethod.Get, s.entryPreview())
        val byDate = request(s.boss, HttpMethod.Get, "/api/projects/${s.projectId}/reports/2026-09-29/sign-preview")
        assertEquals(HttpStatusCode.OK, byProject.status)
        assertEquals(HttpStatusCode.OK, byEntry.status)
        assertEquals(HttpStatusCode.OK, byDate.status)
        val preview = json(byProject.bodyAsText())
        assertEquals(preview, json(byEntry.bodyAsText()), "both routes answer the same")
        assertEquals(preview, json(byDate.bodyAsText()), "a date names the entry as well")
        assertEquals(setOf("partA", "partASha256"), preview.keys)
        assertEquals("private, no-store", byProject.headers[HttpHeaders.CacheControl], "a copy of an earlier answer is part A as it was")

        // It is part A as it stands now: the digest is that of the text signing would store.
        val digest = preview["partASha256"]!!.jsonPrimitive.content
        assertEquals(PartASnapshot.sha256(PartASnapshot.build(dsl, s.projectId)), digest)
        val shown = preview["partA"]!!.jsonObject
        assertEquals("Bytový dům Zelená", shown["identification"]!!.jsonObject["name"]!!.jsonPrimitive.content)
        assertTrue(shown["members"].toString().contains("Elektroinstalace"), "the scope of a member is in what is shown")
        assertTrue(shown["authorizedPersons"].toString().contains("Ing. Dozor"), "so is an authorised person")

        // Reading it changes nothing and records nothing.
        assertEquals(rowsBefore, auditRows())
        assertFalse(isSigned(s.reportId))

        // Signing with that digest signs exactly what was shown.
        val signed = request(s.boss, HttpMethod.Post, s.projectSign(), """{"password":"Password123!","expectedPartASha256":"$digest"}""")
        assertEquals(HttpStatusCode.OK, signed.status, signed.bodyAsText())
        val stored = dsl.select(DAILY_REPORTS.PARTASNAPSHOT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(s.reportId))).fetchOne(DAILY_REPORTS.PARTASNAPSHOT)!!
        assertEquals(digest, PartASnapshot.sha256(stored), "what was stored hashes to what the signer saw")
        assertEquals(shown, json(stored), "and says what the signer saw")
    }

    @Test
    fun `a change of a member's scope between the preview and the click is 409 STALE_VERSION, signs nothing, records nothing`() = testApplication {
        application { module() }
        val s = site()
        staleThenFresh(s) {
            ProjectMemberService.addMember(s.coManager, s.projectId, AddMemberRequest(s.boss.id.toString(), "BOSS", scope = "Přístavba, statika"))
        }
    }

    @Test
    fun `a new authorised person between the preview and the click is 409 STALE_VERSION, signs nothing, records nothing`() = testApplication {
        application { module() }
        val s = site()
        staleThenFresh(s) {
            AuthorizedPersonService.create(s.coManager, s.projectId, CreateAuthorizedPersonRequest(name = "Ing. Nový", authorization = "Zapisuje do deníku"))
        }
    }

    @Test
    fun `a changed contractor between the preview and the click is 409 STALE_VERSION, signs nothing, records nothing`() = testApplication {
        application { module() }
        val s = site()
        staleThenFresh(s) {
            val current = ProjectService.getProject(dsl, s.coManager, s.projectId)
            ProjectService.updateProject(s.coManager, s.projectId, current.copy(contractor = "Jiný zhotovitel s.r.o., IČO 12345678"))
        }
    }

    /**
     * The signer opens the dialog (the preview), somebody changes part A, the signer presses the button: refused on both routes with
     * the same answer as the other version conflicts, nothing signed, no audit row; a signer who looks again (a new preview) signs.
     */
    private suspend fun ApplicationTestBuilder.staleThenFresh(s: Site, change: suspend () -> Unit) {
        val seen = json(request(s.boss, HttpMethod.Get, s.projectPreview()).bodyAsText())["partASha256"]!!.jsonPrimitive.content
        change()
        val rowsBefore = auditRows()

        for (path in listOf(s.projectSign(), s.entrySign())) {
            val refused = request(s.boss, HttpMethod.Post, path, """{"password":"Password123!","expectedPartASha256":"$seen"}""")
            assertEquals(HttpStatusCode.Conflict, refused.status, "$path: ${refused.bodyAsText()}")
            val body = json(refused.bodyAsText())
            assertEquals("STALE_VERSION", body["code"]!!.jsonPrimitive.content, path)
            val message = body["error"]!!.jsonPrimitive.content
            assertTrue(message.contains("Údaje o stavbě") && message.contains("změnily") && message.contains("znovu"), message)
        }
        assertFalse(isSigned(s.reportId), "nothing was signed")
        assertNull(
            dsl.select(DAILY_REPORTS.PARTASNAPSHOT).from(DAILY_REPORTS).where(DAILY_REPORTS.ID.eq(UUID.fromString(s.reportId))).fetchOne(DAILY_REPORTS.PARTASNAPSHOT),
            "no snapshot was stored",
        )
        assertEquals(rowsBefore, auditRows(), "no audit row was written")

        val fresh = json(request(s.boss, HttpMethod.Get, s.projectPreview()).bodyAsText())["partASha256"]!!.jsonPrimitive.content
        assertNotEquals(seen, fresh, "the preview shows the changed part A")
        val signed = request(s.boss, HttpMethod.Post, s.projectSign(), """{"password":"Password123!","expectedPartASha256":"$fresh"}""")
        assertEquals(HttpStatusCode.OK, signed.status, signed.bodyAsText())
        assertTrue(isSigned(s.reportId))
    }

    @Test
    fun `a request without the digest, or with one that is not a SHA-256, is 400 on both routes and signs nothing`() = testApplication {
        application { module() }
        val s = site()
        val good = partADigest(s.projectId)
        val bodies = listOf(
            "" to "an empty body",
            """{"password":"Password123!"}""" to "no digest",
            """{"password":"Password123!","expectedPartASha256":""}""" to "an empty digest",
            """{"password":"Password123!","expectedPartASha256":"   "}""" to "a blank digest",
            """{"password":"Password123!","expectedPartASha256":"abc"}""" to "a short digest",
            """{"password":"Password123!","expectedPartASha256":"${good.dropLast(1)}"}""" to "63 characters",
            """{"password":"Password123!","expectedPartASha256":"${good.dropLast(1)}z"}""" to "not hexadecimal",
            """{"password":"Password123!","expectedPartASha256":12345}""" to "a number",
            """{"password":"Password123!","expectedUpdatedAt":null}""" to "only the version",
        )
        for (path in listOf(s.projectSign(), s.entrySign())) {
            for ((body, what) in bodies) {
                val response = request(s.boss, HttpMethod.Post, path, body)
                assertEquals(HttpStatusCode.BadRequest, response.status, "$path, $what: ${response.bodyAsText()}")
            }
        }
        assertFalse(isSigned(s.reportId))
        // The good digest in upper case is the same digest.
        assertEquals(HttpStatusCode.OK, request(s.boss, HttpMethod.Post, s.entrySign(), """{"password":"Password123!","expectedPartASha256":"${good.uppercase()}"}""").status)
    }

    @Test
    fun `a person who may not sign is told 403 before the body is looked at, on both routes and for the preview`() = testApplication {
        application { module() }
        val s = site()
        val stranger = createTestUser(role = Role.BOSS)
        ProjectService.createProject(
            stranger,
            ProjectDto(id = "", name = "Somebody else's", address = "A", cadastralArea = "B", parcelNumbers = "1", builder = "C", contractor = "D", siteManagerId = stranger.id.toString()),
        )
        val admin = createTestUser(role = Role.BOSS, isAdmin = true)
        val noNumber = createTestUser(role = Role.BOSS, ckaitNumber = null)
        addMember(s.projectId, noNumber, Role.BOSS)
        val investor = createTestUser(role = Role.INVESTOR)
        addMember(s.projectId, investor)

        // Whatever the body is: not JSON, empty, no digest, a digest that is wrong.
        val bodies = listOf("{not json", "", """{"password":"Password123!"}""", """{"password":"Password123!","expectedPartASha256":"${"0".repeat(64)}"}""")
        for (who in listOf(s.worker to "a worker", investor to "a client", stranger to "a manager of another project", admin to "an administrator who is no member")) {
            for (path in listOf(s.projectSign(), s.entrySign())) {
                for (body in bodies) {
                    assertEquals(HttpStatusCode.Forbidden, request(who.first, HttpMethod.Post, path, body).status, "${who.second}: $path with '$body'")
                }
            }
            assertEquals(HttpStatusCode.Forbidden, request(who.first, HttpMethod.Get, s.projectPreview()).status, "${who.second}: the preview by project")
            assertEquals(HttpStatusCode.Forbidden, request(who.first, HttpMethod.Get, s.entryPreview()).status, "${who.second}: the preview by entry")
        }
        // A manager without a ČKAIT number cannot sign, and is told so when the dialog opens, not after the password.
        val noNumberPreview = request(noNumber, HttpMethod.Get, s.projectPreview())
        assertEquals(HttpStatusCode.Forbidden, noNumberPreview.status)
        assertEquals("SIGNER_NOT_QUALIFIED", json(noNumberPreview.bodyAsText())["code"]!!.jsonPrimitive.content)
        assertEquals(HttpStatusCode.Forbidden, request(noNumber, HttpMethod.Post, s.projectSign(), "{not json").status)
        assertFalse(isSigned(s.reportId))
    }

    @Test
    fun `the preview is only for a draft, so a signed entry, an unknown entry and an entry of another project are refused`() = testApplication {
        application { module() }
        val s = site()
        val other = UUID.fromString(
            ProjectService.createProject(
                s.boss,
                ProjectDto(id = "", name = "Druhá stavba", address = "A", cadastralArea = "B", parcelNumbers = "1", builder = "C", contractor = "D", siteManagerId = s.boss.id.toString()),
            ).id,
        )
        val otherReport = DailyReportService.createReport(s.boss, other, "2026-09-29")

        assertEquals(HttpStatusCode.NotFound, request(s.boss, HttpMethod.Get, "/api/projects/${s.projectId}/reports/${otherReport.id}/sign-preview").status, "an entry of another project")
        assertEquals(HttpStatusCode.NotFound, request(s.boss, HttpMethod.Get, "/api/projects/${s.projectId}/reports/2026-01-01/sign-preview").status, "a day without an entry")
        assertEquals(HttpStatusCode.NotFound, request(s.boss, HttpMethod.Get, "/api/reports/${UUID.randomUUID()}/sign-preview").status, "an unknown entry")
        assertEquals(HttpStatusCode.BadRequest, request(s.boss, HttpMethod.Get, "/api/reports/2026-09-29/sign-preview").status, "a date does not name an entry on this route")

        assertEquals(HttpStatusCode.OK, request(s.boss, HttpMethod.Post, s.projectSign(), signBody(s.projectId)).status)
        val signed = request(s.boss, HttpMethod.Get, s.projectPreview())
        assertEquals(HttpStatusCode.Conflict, signed.status)
        assertTrue(signed.bodyAsText().contains("již podepsán"), signed.bodyAsText())
        assertEquals(HttpStatusCode.Conflict, request(s.boss, HttpMethod.Get, s.entryPreview()).status)
    }

    @Test
    fun `the preview is stable while nothing changes and follows every change of part A`() = testApplication {
        application { module() }
        val s = site()
        suspend fun digest() = json(request(s.boss, HttpMethod.Get, s.projectPreview()).bodyAsText())["partASha256"]!!.jsonPrimitive.content

        val first = digest()
        assertEquals(first, digest(), "asking twice gives the same digest")
        // The entry is not part A: saving it does not move the digest.
        DailyReportService.saveReport(s.boss, s.projectId, "2026-09-29", DailyReportService.ReportInput(workDescription = "Betonáž stropu"))
        assertEquals(first, digest())
        // Part A is: the identification, the persons, the authorised persons.
        ProjectMemberService.addMember(s.boss, s.projectId, AddMemberRequest(s.coManager.id.toString(), "BOSS", scope = "Statika"))
        val withScope = digest()
        assertNotEquals(first, withScope)
        AuthorizedPersonService.create(s.boss, s.projectId, CreateAuthorizedPersonRequest(name = "Ing. Dozor"))
        assertNotEquals(withScope, digest())
    }

    @Test
    fun `a part A that is too large to be signed is refused already by the preview, with the same message as signing`() = testApplication {
        application { module() }
        val s = site()
        dsl.update(PROJECTS).set(PROJECTS.SUPPORTINGDOCUMENTS, "x".repeat(PartASnapshot.MAX_BYTES)).where(PROJECTS.ID.eq(s.projectId)).execute()

        val preview = request(s.boss, HttpMethod.Get, s.projectPreview())
        assertEquals(HttpStatusCode.Conflict, preview.status)
        assertTrue(preview.bodyAsText().contains("příliš rozsáhlé"), preview.bodyAsText())
    }
}
