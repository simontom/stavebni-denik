package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS
import org.jooq.DSLContext
import org.jooq.impl.DSL
import java.time.Duration
import java.time.OffsetDateTime

/**
 * Counts failed attempts per (bucket, key) in the database, so limits survive a restart and hold
 * across several instances. Only *failures* are recorded: a successful login does not reset the
 * counter, so an attacker who owns one valid account cannot use it to wipe the count for an address.
 */
object RateLimiter {

    class Rule(val bucket: String, val maxFailures: Int, val window: Duration)

    /** How long the caller has to wait before the next attempt, or null when it may go ahead. */
    fun retryAfter(tx: DSLContext, rule: Rule, key: String): Duration? {
        val now = OffsetDateTime.now()
        val since = now.minus(rule.window)
        val inWindow = DSL.and(
            RATE_LIMIT_ATTEMPTS.BUCKET.eq(rule.bucket),
            RATE_LIMIT_ATTEMPTS.KEY.eq(key),
            RATE_LIMIT_ATTEMPTS.CREATED_AT.gt(since),
        )
        val count = tx.fetchCount(RATE_LIMIT_ATTEMPTS, inWindow)
        if (count < rule.maxFailures) return null

        // Attempts are allowed again once enough old failures have left the window.
        val blocking = tx.select(RATE_LIMIT_ATTEMPTS.CREATED_AT)
            .from(RATE_LIMIT_ATTEMPTS)
            .where(inWindow)
            .orderBy(RATE_LIMIT_ATTEMPTS.CREATED_AT.asc())
            .offset(count - rule.maxFailures)
            .limit(1)
            .fetchOne(RATE_LIMIT_ATTEMPTS.CREATED_AT) ?: return null
        val wait = Duration.between(now, blocking.plus(rule.window))
        return if (wait.isNegative || wait.isZero) Duration.ofSeconds(1) else wait
    }

    fun recordFailure(tx: DSLContext, rule: Rule, key: String) {
        tx.insertInto(RATE_LIMIT_ATTEMPTS)
            .set(RATE_LIMIT_ATTEMPTS.BUCKET, rule.bucket)
            .set(RATE_LIMIT_ATTEMPTS.KEY, key)
            .execute()
        // Housekeeping: failures of this key that are long out of any window are of no use any more.
        tx.deleteFrom(RATE_LIMIT_ATTEMPTS)
            .where(RATE_LIMIT_ATTEMPTS.BUCKET.eq(rule.bucket))
            .and(RATE_LIMIT_ATTEMPTS.KEY.eq(key))
            .and(RATE_LIMIT_ATTEMPTS.CREATED_AT.lt(OffsetDateTime.now().minusDays(1)))
            .execute()
    }

    /** Forgets the failures of one key, e.g. after an administrator reset the account's password. */
    fun clear(tx: DSLContext, rule: Rule, key: String) {
        tx.deleteFrom(RATE_LIMIT_ATTEMPTS)
            .where(RATE_LIMIT_ATTEMPTS.BUCKET.eq(rule.bucket))
            .and(RATE_LIMIT_ATTEMPTS.KEY.eq(key))
            .execute()
    }

    /** "1 minutu", "3 minuty", "10 minut": the wait as it reads in a Czech sentence after "za". */
    fun describeWait(wait: Duration): String {
        val minutes = (wait.seconds + 59) / 60
        return when {
            minutes <= 1 -> "minutu"
            minutes in 2..4 -> "$minutes minuty"
            else -> "$minutes minut"
        }
    }

    /** The limits of the credential endpoints. */
    object Rules {
        /** Failed logins per client address (shared offices and NAT make this generous). */
        val LOGIN_IP = Rule("login:ip", maxFailures = 30, window = Duration.ofMinutes(15))

        /**
         * Failed logins per account name, whoever tries. Stops a guessing run spread over many addresses.
         * The price: someone can lock a known name for up to 15 minutes; an administrator can lift it
         * with a password reset.
         */
        val LOGIN_USER = Rule("login:user", maxFailures = 20, window = Duration.ofMinutes(15))

        /** Wrong "current password" answers when changing one's own password. */
        val PASSWORD_CHANGE = Rule("pwchange:user", maxFailures = 5, window = Duration.ofMinutes(15))
    }
}
