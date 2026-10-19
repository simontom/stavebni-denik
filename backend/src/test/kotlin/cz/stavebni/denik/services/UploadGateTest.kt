package cz.stavebni.denik.services

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * The limits on uploads in flight, in two stages: an upload in progress per user (taken on arrival), and a body in memory
 * for the whole server (taken only once the upload is authorised).
 */
class UploadGateTest {

    private val alice = UUID.randomUUID()
    private val bob = UUID.randomUUID()
    private val carol = UUID.randomUUID()

    private fun UploadGate.enter(user: UUID): UploadGate.Permit = tryEnter(user) ?: fail("expected a place for $user")
    private fun UploadGate.body(): UploadGate.Permit = tryTakeBody() ?: fail("expected a place for a body")

    @Test
    fun `a user gets their share of uploads and is then told to wait`() {
        val gate = UploadGate(maxBodies = 10, maxPerUser = 2)

        val first = gate.enter(alice)
        gate.enter(alice)

        assertNull(gate.tryEnter(alice))
        assertNotNull(gate.tryEnter(bob), "somebody else is not affected")
        first.close()
        assertNotNull(gate.tryEnter(alice), "a finished upload makes room")
    }

    @Test
    fun `the server as a whole is bounded in bodies however many users there are`() {
        val gate = UploadGate(maxBodies = 3, maxPerUser = 2)
        val held = List(3) { gate.body() }

        assertNull(gate.tryTakeBody())

        held[1].close()
        assertNotNull(gate.tryTakeBody())
    }

    @Test
    fun `the two stages are independent, so uploads that are not authorised use no place for a body`() {
        val gate = UploadGate(maxBodies = 1, maxPerUser = 2)

        // Four uploads in progress (two users) and not one of them has been authorised yet.
        List(2) { gate.enter(alice) } + List(2) { gate.enter(bob) }
        assertEquals(4, gate.uploads.value)
        assertEquals(0, gate.bodies.value, "an upload that is only in progress holds no body")

        val body = gate.body()
        assertNull(gate.tryTakeBody())
        assertEquals(1, gate.bodies.value)
        body.close()
        assertEquals(0, gate.bodies.value)
    }

    @Test
    fun `closing a permit twice gives back one place, not two`() {
        val gate = UploadGate(maxBodies = 10, maxPerUser = 2)
        val one = gate.enter(alice)
        gate.enter(alice)
        val body = gate.body()
        gate.body()

        one.close()
        one.close()
        body.close()
        body.close()

        assertEquals(1, gate.uploads.value)
        assertEquals(1, gate.uploadsOf(alice))
        assertEquals(1, gate.bodies.value)
        assertNotNull(gate.tryEnter(alice))
        assertNull(gate.tryEnter(alice), "still only two at a time")
    }

    @Test
    fun `nothing is remembered about a user whose uploads are all over`() {
        val gate = UploadGate(maxBodies = 10, maxPerUser = 2)
        repeat(100) { gate.enter(UUID.randomUUID()).close() }

        assertEquals(0, gate.uploads.value)
        assertEquals(0, gate.usersTracked, "a long-running server must not grow a table of everybody who ever uploaded")
    }

    @Test
    fun `the counts are observable, so that a test can wait for an event instead of a time`() = runBlocking<Unit> {
        val gate = UploadGate(maxBodies = 10, maxPerUser = 2)
        val upload = gate.enter(alice)
        val body = gate.body()

        withTimeout(5_000) { gate.uploads.first { it == 1 } }
        withTimeout(5_000) { gate.bodies.first { it == 1 } }
        body.close()
        upload.close()
        withTimeout(5_000) { gate.uploads.first { it == 0 } }
        withTimeout(5_000) { gate.bodies.first { it == 0 } }
    }

    @Test
    fun `forty threads that all hold what they got get exactly what the limits allow, and give everything back`() {
        val gate = UploadGate(maxBodies = 6, maxPerUser = 2)
        val users = List(5) { UUID.randomUUID() }
        val enteredCount = AtomicInteger()
        val turnedAwayCount = AtomicInteger()
        val bodiesCount = AtomicInteger()
        val start = CountDownLatch(1)
        val allTried = CountDownLatch(40)
        val release = CountDownLatch(1)

        // Nobody lets go before everybody has asked, so the outcome does not depend on the timing: each of the 5 users gets
        // exactly 2 of the 8 uploads they try (10 in all), and of those 10 exactly 6 get a place for a body.
        val threads = List(40) { n ->
            thread {
                start.await()
                val upload = gate.tryEnter(users[n % users.size])
                if (upload == null) {
                    turnedAwayCount.incrementAndGet()
                    allTried.countDown()
                } else {
                    enteredCount.incrementAndGet()
                    val body = gate.tryTakeBody()
                    if (body != null) bodiesCount.incrementAndGet()
                    allTried.countDown()
                    release.await()
                    body?.close()
                    upload.close()
                }
            }
        }
        start.countDown()
        assertTrue(allTried.await(60, TimeUnit.SECONDS), "every thread asked")

        assertEquals(10, enteredCount.get(), "2 uploads for each of 5 users")
        assertEquals(30, turnedAwayCount.get())
        assertEquals(6, bodiesCount.get(), "the places for bodies of the whole server")
        assertEquals(10, gate.uploads.value)
        assertEquals(6, gate.bodies.value)

        release.countDown()
        threads.forEach { it.join(60_000) }
        assertTrue(threads.none { it.isAlive }, "every thread finished")
        assertEquals(0, gate.uploads.value)
        assertEquals(0, gate.bodies.value)
        assertEquals(0, gate.usersTracked)
    }

    @Test
    fun `threads that take and give back in a loop never get more than either limit allows`() {
        val gate = UploadGate(maxBodies = 6, maxPerUser = 2)
        val users = List(5) { UUID.randomUUID() }
        val activeBodies = AtomicInteger()
        val maxBodiesSeen = AtomicInteger()
        val activePerUser = users.associateWith { AtomicInteger() }
        val maxPerUserSeen = AtomicInteger()
        val start = CountDownLatch(1)

        val threads = List(40) { n ->
            val user = users[n % users.size]
            thread {
                start.await()
                repeat(500) {
                    val upload = gate.tryEnter(user) ?: return@repeat
                    maxPerUserSeen.accumulateAndGet(activePerUser.getValue(user).incrementAndGet(), ::maxOf)
                    val body = gate.tryTakeBody()
                    if (body != null) maxBodiesSeen.accumulateAndGet(activeBodies.incrementAndGet(), ::maxOf)
                    Thread.onSpinWait()
                    if (body != null) activeBodies.decrementAndGet()
                    activePerUser.getValue(user).decrementAndGet()
                    body?.close()
                    upload.close()
                }
            }
        }
        start.countDown()
        threads.forEach { it.join(60_000) }

        // What is counted here is a lower bound of what the gate hands out at that moment, so a gate that handed out too many
        // would show it sooner or later; the exact counts are pinned by the test above. No claim about contention here.
        assertTrue(maxBodiesSeen.get() <= 6, "never more than 6 bodies, saw ${maxBodiesSeen.get()}")
        assertTrue(maxPerUserSeen.get() <= 2, "never more than 2 per user, saw ${maxPerUserSeen.get()}")
        assertTrue(threads.none { it.isAlive }, "every thread finished")
        assertEquals(0, gate.uploads.value)
        assertEquals(0, gate.bodies.value)
        assertEquals(0, gate.usersTracked)
    }
}
