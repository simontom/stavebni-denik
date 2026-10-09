package cz.stavebni.denik.cli

import cz.stavebni.denik.db.DatabaseFactory
import cz.stavebni.denik.services.AdminBootstrapService
import cz.stavebni.denik.services.AuditAnchor
import cz.stavebni.denik.services.AuditService
import cz.stavebni.denik.services.ReportSignature
import ch.qos.logback.classic.Level
import kotlinx.coroutines.runBlocking
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import kotlin.system.exitProcess

/**
 * Operator commands that run outside the web application, against the same database:
 *
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt migrate
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt create-admin <nickname> <displayName>
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt reset-password <nickname>
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt audit-head
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt audit-verify [<id>:<hash>]
 *     java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt verify-signatures
 *
 * `verify-signatures` hashes every signed entry again and every photo file under UPLOADS_DIR, and compares them with what
 * was recorded when the entry was signed and the photo uploaded. It reads only. It is what a restore from a backup runs to
 * prove that nothing signed has changed; exit 1 when something no longer matches.
 *
 * `migrate` brings the schema up to date with the OWNER role's credentials (DB_MIGRATE_USER / DB_MIGRATE_PASSWORD; JDBC_URL as
 * for the application) and, when DB_APP_ROLE names the application's role, gives that role its data-access privileges
 * (db/grants/app-role.sql). In production the application never migrates: run this first, from a place that holds the
 * owner's password and the application's machine does not.
 *
 * The other commands run as the application's role (DB_USER). In production they do not migrate and refuse a schema that is
 * not current; elsewhere they migrate as before.
 *
 * The two audit commands only read: they do not migrate the schema, so they work with a read-only database role and
 * can run from a scheduler against a database that a newer or older version of the application owns.
 *
 * Exit codes: 0 done / chain intact, 1 refused / chain BROKEN, 2 wrong usage, 3 the command could not be carried out
 * (database unreachable, schema missing, ...). A check that could not run must never look like a broken chain, nor like
 * an intact one.
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
    val production = System.getenv("APP_ENV")?.lowercase() == "production"
    exitProcess(
        AdminCli.runGuarded(args.toList(), out = ::println, err = System.err::println) {
            // `migrate` connects by itself, with the owner's credentials; the others connect as the application's role.
            if (args.first() != "migrate") {
                DatabaseFactory.init(
                    jdbcUrl = System.getenv("JDBC_URL") ?: "jdbc:postgresql://localhost:5432/stavebni_denik",
                    user = System.getenv("DB_USER") ?: "denik",
                    password = System.getenv("DB_PASSWORD") ?: "denik_dev",
                    // Production: the application's role migrates nothing; it must find the schema current.
                    migrate = !production && !AdminCli.readsOnly(args.toList()),
                    requireCurrent = production,
                )
            }
        },
    )
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
  migrate                                 migrate the schema as the owner role (DB_MIGRATE_USER / DB_MIGRATE_PASSWORD) and grant DB_APP_ROLE
  create-admin <nickname> <displayName>   create the first administrator (only while there is none)
  reset-password <nickname>               give an active user a new temporary password
  audit-head                              print the newest audit-log row as <id>:<hash> (the anchor to record elsewhere)
  audit-verify [<id>:<hash>]              verify the audit-log hash chain; with an anchor, also that the log was not cut
  verify-signatures                       hash every signed entry and photo file again and compare with what was recorded"""

    /** Whether [args] name a command with the right number of arguments. */
    fun hasValidShape(args: List<String>): Boolean =
        when (args.firstOrNull()) {
            "migrate" -> args.size == 1
            "create-admin" -> args.size == 3
            "reset-password" -> args.size == 2
            "audit-head" -> args.size == 1
            "verify-signatures" -> args.size == 1
            "audit-verify" -> args.size == 1 || (args.size == 2 && AuditAnchor.parse(args[1]) != null)
            else -> false
        }

    /** The commands that only read: they never change the schema or any row. */
    fun readsOnly(args: List<String>): Boolean = args.firstOrNull() in setOf("audit-head", "audit-verify", "verify-signatures")

    /**
     * [connect] opens the database; [run] then carries the command out. Anything unexpected on the way (a refused
     * connection, a missing table) is exit code 3 with a one-line reason: not a stack trace on the terminal, and not
     * the code that means "the chain is broken".
     */
    fun runGuarded(args: List<String>, out: (String) -> Unit, err: (String) -> Unit, connect: () -> Unit): Int =
        try {
            connect()
            run(args, out, err)
        } catch (e: Exception) {
            // The first line only: a driver message can be long, and must not carry anything but what went wrong.
            err("Could not carry out the command: ${e.javaClass.simpleName}: ${e.message?.lineSequence()?.firstOrNull().orEmpty()}")
            3
        }

    /** Returns the process exit code: 0 done, 1 refused, 2 wrong usage. */
    fun run(args: List<String>, out: (String) -> Unit, err: (String) -> Unit): Int {
        val command = args.firstOrNull()
        val usage = { err(USAGE); 2 }
        return when (command) {
            "migrate" -> {
                if (args.size != 1) return usage()
                migrate(out)
            }
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
                val result = AuditService.verifyChain(DatabaseFactory.dsl)
                val head = result.head
                when {
                    // A head of a damaged chain must never be recorded as the anchor to trust.
                    !result.ok -> { err("Audit log BROKEN: ${result.reason}"); 1 }
                    head == null -> { err("The audit log is empty."); 1 }
                    else -> { out(head.toString()); 0 }
                }
            }
            "verify-signatures" -> {
                if (args.size != 1) return usage()
                val result = ReportSignature.checkAll(DatabaseFactory.dsl)
                if (result.ok) {
                    out("Signatures OK: ${result.signed} signed entries" + if (result.withoutHash > 0) " (${result.withoutHash} signed before hashes existed: nothing to compare)." else ".")
                    0
                } else {
                    result.problems.forEach { err("Signature BROKEN: $it") }
                    1
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

    /** Migrates with the owner's credentials, and grants the application's role when it is named. */
    private fun migrate(out: (String) -> Unit): Int {
        val url = System.getenv("JDBC_URL") ?: "jdbc:postgresql://localhost:5432/stavebni_denik"
        val user = System.getenv("DB_MIGRATE_USER") ?: System.getenv("DB_USER") ?: "denik"
        val password = System.getenv("DB_MIGRATE_PASSWORD") ?: System.getenv("DB_PASSWORD") ?: "denik_dev"
        val appRole = System.getenv("DB_APP_ROLE")?.takeIf { it.isNotBlank() }
        DatabaseFactory.pool(url, user, password, maxSize = 2).use { ds ->
            val executed = DatabaseFactory.migrate(ds)
            out("Schema migrated as '$user': $executed migration(s) applied.")
            if (appRole != null) {
                DatabaseFactory.grantAppRole(ds, appRole)
                out("Privileges of '$appRole' set: data access only.")
            }
        }
        return 0
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
