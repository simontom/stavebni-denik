package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.ACCESS_LOG
import cz.stavebni.denik.jooq.tables.references.AUDIT_REQUEST_CONTEXT
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.slf4j.LoggerFactory
import java.time.OffsetDateTime
import java.util.UUID

/**
 * Sign-ins, failed sign-ins and sign-outs, for security investigations (who came from where, and when).
 *
 * It is **not** part of the legal audit chain: nothing here is evidence about the diary, and it holds personal data
 * (the address and the user agent), so it is kept for [RETENTION_MONTHS] months and then deleted. The database refuses to
 * change a row, or to delete one younger than that, so that someone holding the application's credentials cannot erase
 * their traces (migration V12). The same retention applies to `audit_request_context`, the address and user agent of the
 * requests behind audit rows (decision D7).
 */
object AccessLogService {
    private val log = LoggerFactory.getLogger(AccessLogService::class.java)

    /** How long the address and user agent are kept. The database enforces the same period (V12). */
    const val RETENTION_MONTHS = 12L

    enum class Event(val code: String) {
        LOGIN_SUCCESS("login.success"),
        LOGIN_FAILURE("login.failure"),
        LOGOUT("logout"),
    }

    /**
     * Records one event. A failure to record never stops the person from signing in or out (that would let a broken
     * log lock everyone out), but it is logged loudly: a gap in this log is something to notice.
     *
     * [userId] is the account, when there is one. For a failed attempt against a name that does not exist it is null, and
     * the name is never recorded: what was typed into the name field may be a password.
     */
    fun record(db: DSLContext, event: Event, userId: UUID?, ip: String?, userAgent: String?) {
        try {
            db.insertInto(ACCESS_LOG)
                .set(ACCESS_LOG.EVENT, event.code)
                .set(ACCESS_LOG.USER_ID, userId)
                .set(ACCESS_LOG.IP, ip?.take(64))
                .set(ACCESS_LOG.USER_AGENT, userAgent?.take(256))
                .execute()
        } catch (e: Exception) {
            log.warn("The access log could not record {} (user {}): {}", event.code, userId, e.message)
        }
    }

    /** How many rows [prune] removed from each table. */
    class Pruned(val accessLog: Int, val auditRequestContext: Int)

    /**
     * Deletes what is older than [RETENTION_MONTHS] months from both tables. The cutoff is the database's own clock, the
     * one its guard uses, so the two cannot disagree; the database refuses anything younger.
     * Run it regularly (see docs/DEPLOYMENT.md): the retention is a promise made in the privacy notice.
     */
    fun prune(db: DSLContext): Pruned {
        val cutoff = DSL.field("CURRENT_TIMESTAMP - INTERVAL '$RETENTION_MONTHS months'", OffsetDateTime::class.java)
        val accessLog = db.deleteFrom(ACCESS_LOG).where(ACCESS_LOG.RECORDED_AT.lt(cutoff)).execute()
        val context = db.deleteFrom(AUDIT_REQUEST_CONTEXT).where(AUDIT_REQUEST_CONTEXT.RECORDED_AT.lt(cutoff)).execute()
        return Pruned(accessLog, context)
    }
}
