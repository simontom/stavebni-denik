package cz.stavebni.denik.plugins

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.jooq.tables.references.AUDIT_LOG
import cz.stavebni.denik.module
import cz.stavebni.denik.services.appendTestAuditRow
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.slf4j.LoggerFactory

/**
 * An audit row that the application cannot write (it names no project, its entity type has no rule, a snapshot is not JSON)
 * is a mistake of the code. The client must not be told it was a conflict or a bad request, nor shown any internal text:
 * it gets a plain server error in Czech, the change is not made, and the log says what happened without any content of the row.
 */
class AuditFailureResponseTest : BaseIntegrationTest() {

    private val secret = "Tajný zápis č. 7"

    private fun logger() = LoggerFactory.getLogger("cz.stavebni.denik.plugins.StatusPages") as Logger

    private inline fun <T> capturingErrors(body: (ListAppender<ILoggingEvent>) -> T): T {
        val appender = ListAppender<ILoggingEvent>().also { it.start() }
        val logger = logger()
        logger.addAppender(appender)
        try {
            return body(appender)
        } finally {
            logger.detachAppender(appender)
        }
    }

    private fun ApplicationTestBuilder.audited() = application {
        module()
        routing {
            // A row of an entity type that has no rule, with content that must never leave the server.
            get("/test/audit/unknown-type") {
                appendTestAuditRow(null, "invoice.create", "i1", entityType = "invoice", after = buildJsonObject { put("text", secret) })
                call.respond("unreachable")
            }
            // A row of a project whose snapshot names none.
            get("/test/audit/no-project") {
                appendTestAuditRow(null, "report.update", "r1", entityType = "report", after = buildJsonObject { put("text", secret) })
                call.respond("unreachable")
            }
            // A snapshot that is not JSON (what used to come back as a 400 that echoed the message).
            get("/test/audit/not-json") {
                appendTestAuditRow(
                    null, "report.update", "r1", entityType = "report",
                    after = buildJsonObject {
                        put("projectId", JsonPrimitive(java.util.UUID.randomUUID().toString()))
                        put("n", JsonUnquotedLiteral("1, \"$secret\""))
                    },
                )
                call.respond("unreachable")
            }
        }
    }

    @Test
    fun `an audit row that cannot be written is a plain server error in Czech, logged, and echoes nothing`() = testApplication {
        audited()

        for (path in listOf("unknown-type", "no-project", "not-json")) {
            capturingErrors { appender ->
                val response = client.get("/test/audit/$path")
                val body = response.bodyAsText()

                assertEquals(HttpStatusCode.InternalServerError, response.status, "$path: $body")
                assertTrue(body.contains("nebyla provedena"), "$path: a Czech sentence saying that the change was not made: $body")
                for (internal in listOf("audit", "Audit", "invoice", "report", "snapshot", "projectId", "rule", "AuditProject", "payload", secret)) {
                    assertFalse(body.contains(internal), "$path: the body must not mention '$internal': $body")
                }

                val errors = appender.list.filter { it.level == Level.ERROR }
                assertEquals(1, errors.size, "$path: exactly one error in the log: ${appender.list.map { it.formattedMessage }}")
                val logged = errors.single().formattedMessage + " " + (errors.single().throwableProxy?.message ?: "")
                assertTrue(logged.contains("audit", ignoreCase = true), "$path: the log says that it was an audit row: $logged")
                assertFalse(logged.contains(secret), "$path: the log holds no content of the row: $logged")
            }
        }
        assertEquals(0, dsl.fetchCount(AUDIT_LOG), "none of them wrote a row")
    }
}
