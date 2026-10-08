package cz.stavebni.denik.services

import cz.stavebni.denik.BaseIntegrationTest
import cz.stavebni.denik.jooq.tables.references.RATE_LIMIT_ATTEMPTS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.Duration

/** The limiter holds exactly, however many attempts arrive at the same moment. */
class RateLimiterReserveTest : BaseIntegrationTest() {

    private val rule = RateLimiter.Rule("test:bucket", maxFailures = 5, window = Duration.ofMinutes(15))
    private val other = RateLimiter.Rule("test:other", maxFailures = 3, window = Duration.ofMinutes(15))

    private fun rows(bucket: String, key: String): Int =
        dsl.fetchCount(RATE_LIMIT_ATTEMPTS, RATE_LIMIT_ATTEMPTS.BUCKET.eq(bucket).and(RATE_LIMIT_ATTEMPTS.KEY.eq(key)))

    @Test
    fun `forty attempts at the same moment get exactly the five the limit allows`() = runBlocking<Unit> {
        val results = (1..40).map { async(Dispatchers.IO) { RateLimiter.reserve(dsl, listOf(rule to "crowd")) } }.awaitAll()

        assertEquals(5, results.count { it.refusedFor == null }, "granted")
        assertEquals(35, results.count { it.refusedFor != null }, "refused")
        assertEquals(5, rows(rule.bucket, "crowd"), "only the granted ones are on record")
    }

    @Test
    fun `a refused attempt is not recorded, so asking again does not extend the wait`() {
        repeat(5) { assertNull(RateLimiter.reserve(dsl, listOf(rule to "k")).refusedFor) }

        repeat(10) { assertNotNull(RateLimiter.reserve(dsl, listOf(rule to "k")).refusedFor) }

        assertEquals(5, rows(rule.bucket, "k"))
    }

    @Test
    fun `a success gives its attempt back and only its own`() {
        val reservations = (1..5).map { RateLimiter.reserve(dsl, listOf(rule to "k")) }
        assertNotNull(RateLimiter.reserve(dsl, listOf(rule to "k")).refusedFor, "at the limit")

        RateLimiter.release(dsl, reservations[2])

        assertEquals(4, rows(rule.bucket, "k"), "one attempt returned, the failures of others stay")
        assertNull(RateLimiter.reserve(dsl, listOf(rule to "k")).refusedFor, "there is room for one more")
        assertNotNull(RateLimiter.reserve(dsl, listOf(rule to "k")).refusedFor)
    }

    @Test
    fun `either every limit has room and all are reserved, or nothing is recorded`() {
        repeat(3) { RateLimiter.reserve(dsl, listOf(other to "name")) } // 'other' is now full

        val refused = RateLimiter.reserve(dsl, listOf(rule to "address", other to "name"))

        assertNotNull(refused.refusedFor)
        assertEquals(0, rows(rule.bucket, "address"), "the limit that had room was not charged for a refused request")
        assertEquals(3, rows(other.bucket, "name"))
    }

    @Test
    fun `different keys do not share a limit`() {
        repeat(5) { RateLimiter.reserve(dsl, listOf(rule to "a")) }

        assertNotNull(RateLimiter.reserve(dsl, listOf(rule to "a")).refusedFor)
        assertNull(RateLimiter.reserve(dsl, listOf(rule to "b")).refusedFor)
    }

    @Test
    fun `requests that name the same two keys in opposite order do not deadlock`() = runBlocking<Unit> {
        withTimeout(30_000) {
            (1..30).map { i ->
                async(Dispatchers.IO) {
                    val limits = listOf(rule to "x", other to "y")
                    RateLimiter.reserve(dsl, if (i % 2 == 0) limits else limits.reversed())
                }
            }.awaitAll()
        }
        assertTrue(rows(rule.bucket, "x") <= 5 && rows(other.bucket, "y") <= 3, "limits held")
    }

    @Test
    fun `an IPv4 address is its own key`() {
        assertEquals("203.0.113.5", RateLimiter.addressKey("203.0.113.5"))
        assertEquals("203.0.113.5", RateLimiter.addressKey("  203.0.113.5  "))
    }

    @Test
    fun `an IPv6 client is counted as its whole 64 bit prefix`() {
        val a = RateLimiter.addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
        val b = RateLimiter.addressKey("2001:db8:1:2::1")
        assertEquals(a, b, "the same /64, different hosts")
        assertEquals("2001:0db8:0001:0002::/64", a)

        assertNotEquals(a, RateLimiter.addressKey("2001:db8:1:3::1"), "another /64")
        // Spelling does not matter: upper case, compressed or not.
        assertEquals(RateLimiter.addressKey("2001:DB8:0:0:ffff::1"), RateLimiter.addressKey("2001:db8::ffff:0:0:2"))
        assertEquals(a, RateLimiter.addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd%eth0"), "a zone id is not part of the address")
    }

    @Test
    fun `an IPv4 address written in IPv6 form is the IPv4 address, and garbage is kept as it is`() {
        assertEquals("203.0.113.5", RateLimiter.addressKey("::ffff:203.0.113.5"))
        assertEquals("not:an:address:at:all:x:y:z:q", RateLimiter.addressKey("NOT:AN:ADDRESS:AT:ALL:X:Y:Z:Q"))
        assertEquals("localhost", RateLimiter.addressKey("localhost"))
        assertEquals(64, RateLimiter.addressKey("a".repeat(500)).length, "an enormous value is cut")
    }
}
