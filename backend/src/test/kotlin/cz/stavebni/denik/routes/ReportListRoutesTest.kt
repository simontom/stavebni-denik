package cz.stavebni.denik.routes

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.domain.SessionUser
import cz.stavebni.denik.module
import cz.stavebni.denik.services.DailyReportService
import cz.stavebni.denik.services.ProjectDto
import cz.stavebni.denik.services.ProjectService
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
import org.jooq.impl.DSL
import org.jooq.impl.DefaultExecuteListenerProvider
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** The list of a project's entries is a bounded page, and asks the database a fixed number of questions. */
class ReportListRoutesTest : BaseIntegrationTest() {

    private suspend fun project(owner: SessionUser): UUID {
        val project = ProjectService.createProject(
            owner,
            ProjectDto(
                id = "", name = "Long diary", address = "Address", cadastralArea = "Area",
                parcelNumbers = "1", builder = "Builder", contractor = "Contractor", siteManagerId = owner.id.toString()
            )
        )
        return UUID.fromString(project.id)
    }

    /** [days] entries on consecutive days ending 2026-09-28 (inserted directly: the point is the list, not the creation rules). */
    private fun entries(projectId: UUID, author: SessionUser, days: Int, last: LocalDate = LocalDate.of(2026, 9, 28), firstSequence: Int = 1) {
        for (i in 0 until days) {
            dsl.execute(
                """insert into daily_reports ("projectId", "sequenceNumber", "date", "authorId", "workDescription", "workersByTrade", "updatedAt")
                   values (?, ?, ?, ?, ?, '[]'::jsonb, now())""",
                projectId, firstSequence + i, last.minusDays((days - 1 - i).toLong()), author.id, "work $i",
            )
        }
    }

    private suspend fun ApplicationTestBuilder.list(projectId: UUID, user: SessionUser, query: String = ""): HttpResponse =
        client.get("/api/projects/$projectId/reports$query") { header(HttpHeaders.Authorization, "Bearer ${generateJwtToken(user)}") }

    private fun dates(response: String): List<String> =
        Json.parseToJsonElement(response).jsonArray.map { it.jsonObject["date"]!!.jsonPrimitive.content.take(10) }

    @Test
    fun `the list is a page, newest day first, and the total is in a header`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)
        entries(p, boss, days = 25)

        val all = list(p, boss)
        assertEquals(HttpStatusCode.OK, all.status)
        assertEquals("25", all.headers["X-Total-Count"])
        assertEquals(25, dates(all.bodyAsText()).size, "fewer than the default page: all of them")
        assertEquals("2026-09-28", dates(all.bodyAsText()).first(), "newest first")

        val firstPage = list(p, boss, "?limit=10")
        assertEquals((0 until 10).map { LocalDate.of(2026, 9, 28).minusDays(it.toLong()).toString() }, dates(firstPage.bodyAsText()))
        assertEquals("25", firstPage.headers["X-Total-Count"], "the total is the whole diary, not the page")

        val secondPage = list(p, boss, "?limit=10&offset=10")
        assertEquals((10 until 20).map { LocalDate.of(2026, 9, 28).minusDays(it.toLong()).toString() }, dates(secondPage.bodyAsText()))

        val tail = list(p, boss, "?limit=10&offset=20")
        assertEquals(5, dates(tail.bodyAsText()).size)
        assertEquals(0, dates(list(p, boss, "?offset=500").bodyAsText()).size, "past the end is an empty page")
    }

    @Test
    fun `a page size outside the allowed range or not a number is a 400`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)

        for (query in listOf("?limit=0", "?limit=-5", "?limit=1001", "?limit=abc", "?offset=-1", "?offset=x", "?limit=99999999999")) {
            assertEquals(HttpStatusCode.BadRequest, list(p, boss, query).status, query)
        }
        assertEquals(HttpStatusCode.OK, list(p, boss, "?limit=1000").status)
    }

    @Test
    fun `the number of database statements does not grow with the number of entries`() = testApplication {
        application { module() }
        val boss = createTestUser(role = Role.BOSS)
        val p = project(boss)

        fun statementsForList(): Int {
            val counter = AtomicInteger()
            val previous = DatabaseFactory.dsl
            val counting = DSL.using(
                previous.configuration().derive(
                    DefaultExecuteListenerProvider(object : ExecuteListener {
                        override fun executeStart(ctx: ExecuteContext) {
                            counter.incrementAndGet()
                        }
                    })
                )
            )
            DatabaseFactory.initDirect(counting)
            try {
                kotlinx.coroutines.runBlocking { DailyReportService.getReports(p) }
            } finally {
                DatabaseFactory.initDirect(previous)
            }
            return counter.get()
        }

        entries(p, boss, days = 3)
        val few = statementsForList()
        entries(p, boss, days = 30, last = LocalDate.of(2026, 8, 1), firstSequence = 100) // more entries, on other days
        val many = statementsForList()

        assertTrue(few <= 4, "a fixed number of statements for a page, was $few")
        assertEquals(few, many, "30 entries cost the same number of statements as 3")
    }
}
