package cz.stavebni.denik.cli

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.services.AdminBootstrapService
import cz.stavebni.denik.services.AuditAnchor
import cz.stavebni.denik.services.AuditService
import ch.qos.logback.classic.Level
import kotlinx.coroutines.runBlocking
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import kotlin.system.exitProcess

/**
 * Operator commands that run outside the web application, against the same database:
 *
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt create-admin <nickname> <displayName>
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt reset-password <nickname>
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt audit-head
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt audit-verify [<id>:<hash>]
 *
 * On Fly.io: `fly ssh console -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt create-admin alice 'Alice Novakova'"`.
 * It reads the same JDBC_URL, DB_USER and DB_PASSWORD as the application. The generated password is printed once, to
 * standard output only, and has to be changed at the first login.
 */
fun main(args: Array<String>) {
    // Wrong usage is answered before any connection is made.
    if (!AdminCli.hasValidShape(args.toList())) {
        System.err.println(AdminCli.USAGE)
        exitProcess(2)
    }
    quietLogging()
    DatabaseFactory.init(
        jdbcUrl = System.getenv("JDBC_URL") ?: "jdbc:postgresql://localhost:5432/stavebni_denik",
        user = System.getenv("DB_USER") ?: "denik",
        password = System.getenv("DB_PASSWORD") ?: "denik_dev",
    )
    exitProcess(AdminCli.run(args.toList(), out = ::println, err = System.err::println))
}

/**
 * The credentials are the point of the output, so keep the framework chatter (connection pool, Flyway, the jOOQ banner)
 * out of it. Warnings and errors still show.
 */
private fun quietLogging() {
    System.setProperty("org.jooq.no-logo", "true")
    System.setProperty("org.jooq.no-tips", "true")
    // logback.xml sets some loggers explicitly, which the root level does not override.
    listOf(Logger.ROOT_LOGGER_NAME, "org.jooq", "io.ktor").forEach { name ->
        (LoggerFactory.getLogger(name) as? ch.qos.logback.classic.Logger)?.level = Level.WARN
    }
}

object AdminCli {
    const val USAGE = """Usage:
  create-admin <nickname> <displayName>   create the first administrator (only while there is none)
  reset-password <nickname>               give an active user a new temporary password
  audit-head                              print the newest audit-log row as <id>:<hash> (the anchor to record elsewhere)
  audit-verify [<id>:<hash>]              verify the audit-log hash chain; with an anchor, also that the log was not cut"""

    /** Whether [args] name a command with the right number of arguments. */
    fun hasValidShape(args: List<String>): Boolean =
        when (args.firstOrNull()) {
            "create-admin" -> args.size == 3
            "reset-password" -> args.size == 2
            "audit-head" -> args.size == 1
            "audit-verify" -> args.size == 1 || (args.size == 2 && AuditAnchor.parse(args[1]) != null)
            else -> false
        }

    /** Returns the process exit code: 0 done, 1 refused, 2 wrong usage. */
    fun run(args: List<String>, out: (String) -> Unit, err: (String) -> Unit): Int {
        val command = args.firstOrNull()
        val usage = { err(USAGE); 2 }
        return when (command) {
            "create-admin" -> {
                if (args.size != 3) return usage()
                attempt(err) { AdminBootstrapService.createFirstAdmin(args[1], args[2]) }
                    ?.also { show(it, "Administrator created.", out) }
                    ?.let { 0 } ?: 1
            }
            "reset-password" -> {
                if (args.size != 2) return usage()
                attempt(err) { AdminBootstrapService.resetPassword(args[1]) }
                    ?.also { show(it, "Password reset. All sessions of the user ended.", out) }
                    ?.let { 0 } ?: 1
            }
            "audit-head" -> {
                if (args.size != 1) return usage()
                val head = AuditService.verifyChain(DatabaseFactory.dsl).head
                if (head == null) {
                    err("The audit log is empty.")
                    1
                } else {
                    out(head.toString())
                    0
                }
            }
            "audit-verify" -> {
                if (args.size !in 1..2) return usage()
                val anchor = args.getOrNull(1)?.let { AuditAnchor.parse(it) ?: return usage() }
                val result = AuditService.verifyChain(DatabaseFactory.dsl, anchor = anchor)
                if (result.ok) {
                    out("Audit log OK: ${result.totalRows} rows, head ${result.head ?: "(empty)"}")
                    if (anchor != null) out("Anchor ${anchor} found unchanged.")
                    0
                } else {
                    err("Audit log BROKEN: ${result.reason}")
                    1
                }
            }
            else -> usage()
        }
    }

    private fun attempt(err: (String) -> Unit, block: suspend () -> AdminBootstrapService.Result): AdminBootstrapService.Result? =
        try {
            runBlocking { block() }
        } catch (e: IllegalArgumentException) {
            err("Refused: ${e.message}"); null
        } catch (e: IllegalStateException) {
            err("Refused: ${e.message}"); null
        }

    private fun show(result: AdminBootstrapService.Result, headline: String, out: (String) -> Unit) {
        out(headline)
        out("User:     ${result.nickname}")
        out("Password: ${result.password}")
        out("The password is shown only now. It has to be changed at the first login.")
    }
}
