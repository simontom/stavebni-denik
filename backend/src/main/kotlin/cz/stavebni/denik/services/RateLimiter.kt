package cz.stavebni.denik.services

import cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS
import org.jooq.DSLContext
import org.jooq.impl.DSL
import java.net.InetAddress
import java.time.Duration
import java.time.OffsetDateTime

/**
 * Counts failed attempts per (bucket, key) in the database, so limits survive a restart and hold
 * across several instances.
 *
 * An attempt is **reserved before** the password is checked and **given back when it succeeds**
 * ([reserve], [release]). Counting only after the check would let any number of requests that are
 * in flight at the same moment all pass the same "not yet blocked" test; a reservation is made
 * under a lock per key, so the limit holds exactly however many requests arrive at once. A success
 * gives back only its own attempt: it does not wipe the failures of others, so an attacker who
 * owns one valid account cannot use it to reset the count for an address.
 */
object RateLimiter {

    class Rule(val bucket: String, val maxFailures: Int, val window: Duration)

    /** What [reserve] decided: either [refusedFor] says how long to wait, or the attempt is reserved under [ids]. */
    class Reservation internal constructor(val refusedFor: Duration?, internal val ids: List<Long>)

    /**
     * Reserves one attempt for every (rule, key) pair, or none: when any of them is at its limit nothing is
     * recorded (a refused request must not extend its own lockout) and [Reservation.refusedFor] is the longest wait.
     */
    fun reserve(db: DSLContext, limits: List<Pair<Rule, String>>): Reservation =
        db.transactionResult { cfg ->
            val tx = DSL.using(cfg)
            // One lock per key, always taken in the same order, so two requests with the same keys cannot deadlock.
            val ordered = limits.sortedWith(compareBy({ it.first.bucket }, { it.second }))
            ordered.forEach { (rule, key) ->
                tx.execute("select pg_advisory_xact_lock(hashtextextended(?, 7))", "${rule.bucket}\u001F$key")
            }
            val wait = ordered.mapNotNull { (rule, key) -> retryAfter(tx, rule, key) }.maxOrNull()
            if (wait != null) {
                Reservation(refusedFor = wait, ids = emptyList())
            } else {
                Reservation(refusedFor = null, ids = ordered.map { (rule, key) -> record(tx, rule, key) })
            }
        }

    /** The attempt succeeded: it was not a failure, so it stops counting. */
    fun release(db: DSLContext, reservation: Reservation) {
        if (reservation.ids.isEmpty()) return
        db.deleteFrom(RATE_LIMIT_ATTEMPTS).where(RATE_LIMIT_ATTEMPTS.ID.`in`(reservation.ids)).execute()
    }

    /**
     * The key under which a client address is counted. An IPv6 customer gets a whole /64 (or more) to itself, so a
     * limit per exact address would be no limit at all: the address is cut to its /64 prefix. An IPv4-mapped IPv6
     * address counts as the IPv4 address; anything that is not an address is used as it is.
     */
    fun addressKey(raw: String): String {
        val text = raw.trim().removePrefix("[").removeSuffix("]").substringBefore('%')
        if (!text.contains(':')) return text.take(64)
        val address = try {
            // In brackets the JDK reads the text strictly as an IPv6 literal. Without them, text that does not parse
            // is looked up as a host name: a request header must never make the server ask DNS anything.
            InetAddress.getByName("[$text]")
        } catch (e: Exception) {
            return text.lowercase().take(64)
        }
        val bytes = address.address
        if (bytes.size == 4) return address.hostAddress
        return (0 until 4).joinToString(":") { i ->
            "%02x%02x".format(bytes[2 * i].toInt() and 0xFF, bytes[2 * i + 1].toInt() and 0xFF)
        } + "::/64"
    }

    /** How long the caller has to wait before the next attempt, or null when it may go ahead. Read-only. */
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

    private fun record(tx: DSLContext, rule: Rule, key: String): Long {
        val id = tx.insertInto(RATE_LIMIT_ATTEMPTS)
            .set(RATE_LIMIT_ATTEMPTS.BUCKET, rule.bucket)
            .set(RATE_LIMIT_ATTEMPTS.KEY, key)
            .returning(RATE_LIMIT_ATTEMPTS.ID)
            .fetchOne()!!
            .get(RATE_LIMIT_ATTEMPTS.ID)!!
        // Housekeeping: failures of this key that are long out of any window are of no use any more.
        tx.deleteFrom(RATE_LIMIT_ATTEMPTS)
            .where(RATE_LIMIT_ATTEMPTS.BUCKET.eq(rule.bucket))
            .and(RATE_LIMIT_ATTEMPTS.KEY.eq(key))
            .and(RATE_LIMIT_ATTEMPTS.CREATED_AT.lt(OffsetDateTime.now().minusDays(1)))
            .execute()
        return id
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
        /** Failed logins per client address (shared offices and NAT make this generous; an IPv6 client counts as its /64). */
        val LOGIN_IP = Rule("login:ip", maxFailures = 30, window = Duration.ofMinutes(15))

        /**
         * Failed logins per account name, whoever tries. Stops a guessing run spread over many addresses.
         * The price: someone can lock a known name for up to 15 minutes; an administrator can lift it
         * with a password reset.
         */
        val LOGIN_USER = Rule("login:user", maxFailures = 20, window = Duration.ofMinutes(15))

        /** Wrong "current password" answers when changing one's own password. */
        val PASSWORD_CHANGE = Rule("pwchange:user", maxFailures = 5, window = Duration.ofMinutes(15))

        /** Wrong passwords given to confirm a signature. */
        val SIGNATURE_PASSWORD = Rule("signpw:user", maxFailures = 5, window = Duration.ofMinutes(15))
    }
}
