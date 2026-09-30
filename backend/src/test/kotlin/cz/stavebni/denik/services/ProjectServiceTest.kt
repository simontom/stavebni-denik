package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.domain.ForbiddenException
import cz.stavebni.denik.domain.Role
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.jooq.tables.references.PROJECTS
import cz.stavebni.denik.jooq.tables.references.PROJECT_MEMBERS
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.UUID

class ProjectServiceTest : BaseIntegrationTest() {

    @Test
    fun `BOSS can create project and creator is added to project members`() = runBlocking {
        val boss = createTestUser(role = Role.BOSS)
        val dto = ProjectDto(
            id = "",
            name = "Stavba RD Praha",
            address = "Slunecna 10, Praha",
            cadastralArea = "Praha-Vychod",
            parcelNumbers = "104/2",
            builder = "Jan Novak",
            contractor = "Stavby s.r.o.",
            siteManagerId = boss.id.toString()
        )

        val created = ProjectService.createProject(boss, dto)
        assertNotNull(created.id)
        assertEquals("Stavba RD Praha", created.name)
        assertEquals(boss.id.toString(), created.siteManagerId)

        // Verify in DB
        val projectId = UUID.fromString(created.id)
        val projectInDb = dsl.selectFrom(PROJECTS).where(PROJECTS.ID.eq(projectId)).fetchOne()
        assertNotNull(projectInDb)
        assertEquals("Stavba RD Praha", projectInDb!!.get(PROJECTS.NAME))

        // Verify project members
        val memberInDb = dsl.selectFrom(PROJECT_MEMBERS)
            .where(PROJECT_MEMBERS.PROJECTID.eq(projectId).and(PROJECT_MEMBERS.USERID.eq(boss.id)))
            .fetchOne()
        assertNotNull(memberInDb)

        // Verify audit log
        val auditLog = dsl.selectFrom(AUDIT_LOG).where(AUDIT_LOG.ACTION.eq("project.create")).fetchOne()
        assertNotNull(auditLog)
        assertEquals(boss.id.toString(), auditLog!!.get(AUDIT_LOG.ACTOR_ID))
    }

    @Test
    fun `WORKER cannot create project and receives ForbiddenException`() {
        runBlocking {
            val worker = createTestUser(role = Role.WORKER)
            val dto = ProjectDto(
                id = "",
                name = "Unauthorized Project",
                address = "Address",
                cadastralArea = "Area",
                parcelNumbers = "1",
                builder = "Builder",
                contractor = "Contractor",
                siteManagerId = worker.id.toString()
            )

            assertThrows<ForbiddenException> {
                runBlocking {
                    ProjectService.createProject(worker, dto)
                }
            }
        }
    }

    @Test
    fun `listProjects returns only member projects for regular user and all projects for admin`() = runBlocking {
        val boss1 = createTestUser(nickname = "boss1", role = Role.BOSS)
        val boss2 = createTestUser(nickname = "boss2", role = Role.BOSS)
        val admin = createTestUser(nickname = "admin", role = Role.WORKER, isAdmin = true)

        val p1 = ProjectService.createProject(boss1, ProjectDto(
            id = "", name = "Project 1", address = "A1", cadastralArea = "C1",
            parcelNumbers = "P1", builder = "B1", contractor = "Co1", siteManagerId = boss1.id.toString()
        ))
        val p2 = ProjectService.createProject(boss2, ProjectDto(
            id = "", name = "Project 2", address = "A2", cadastralArea = "C2",
            parcelNumbers = "P2", builder = "B2", contractor = "Co2", siteManagerId = boss2.id.toString()
        ))

        // boss1 should only see p1
        val boss1Projects = ProjectService.listProjects(dsl, boss1)
        assertEquals(1, boss1Projects.size)
        assertEquals(p1.id, boss1Projects[0].id)

        // boss2 should only see p2
        val boss2Projects = ProjectService.listProjects(dsl, boss2)
        assertEquals(1, boss2Projects.size)
        assertEquals(p2.id, boss2Projects[0].id)

        // admin should see both
        val adminProjects = ProjectService.listProjects(dsl, admin)
        assertEquals(2, adminProjects.size)
        assertTrue(adminProjects.any { it.id == p1.id })
        assertTrue(adminProjects.any { it.id == p2.id })
    }
}
