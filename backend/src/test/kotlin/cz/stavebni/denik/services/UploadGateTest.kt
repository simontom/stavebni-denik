package cz.stavebni.denik.services

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** The limit on upload bodies in flight: per user and for the whole server, held from before the first byte until the end. */
class UploadGateTest {

    private val alice = UUID.randomUUID()
    private val bob = UUID.randomUUID()
    private val carol = UUID.randomUUID()

    private fun UploadGate.permit(user: UUID): UploadGate.Permit =
        tryAcquire(user) as? UploadGate.Permit ?: fail("expected a permit for $user")

    @Test
    fun `a user gets their share of bodies and is then told to wait`() {
        val gate = UploadGate(maxTotal = 10, maxPerUser = 2)

        val first = gate.permit(alice)
        gate.permit(alice)

        assertEquals(UploadGate.Refusal.USER_BUSY, gate.tryAcquire(alice))
        assertTrue(gate.tryAcquire(bob) is UploadGate.Permit, "somebody else is not affected")
        first.close()
        assertTrue(gate.tryAcquire(alice) is UploadGate.Permit, "a finished upload makes room")
    }

    @Test
    fun `the server as a whole is bounded however many users there are`() {
        val gate = UploadGate(maxTotal = 3, maxPerUser = 2)
        val held = listOf(gate.permit(alice), gate.permit(alice), gate.permit(bob))

        assertEquals(UploadGate.Refusal.SERVER_BUSY, gate.tryAcquire(carol))

        held[2].close()
        assertTrue(gate.tryAcquire(carol) is UploadGate.Permit)
    }

    @Test
    fun `a user at their own limit is told so, not that the server is busy`() {
        val gate = UploadGate(maxTotal = 2, maxPerUser = 2)
        gate.permit(alice)
        gate.permit(alice) // both the user and the server are now at their limits

        assertEquals(UploadGate.Refusal.USER_BUSY, gate.tryAcquire(alice))
        assertEquals(UploadGate.Refusal.SERVER_BUSY, gate.tryAcquire(bob))
    }

    @Test
    fun `closing a permit twice gives back one slot, not two`() {
        val gate = UploadGate(maxTotal = 10, maxPerUser = 2)
        val one = gate.permit(alice)
        gate.permit(alice)

        one.close()
        one.close()

        assertEquals(1, gate.inFlight.value)
        assertEquals(1, gate.inFlightOf(alice))
        assertTrue(gate.tryAcquire(alice) is UploadGate.Permit)
        assertEquals(UploadGate.Refusal.USER_BUSY, gate.tryAcquire(alice), "still only two at a time")
    }

    @Test
    fun `nothing is remembered about a user whose uploads are all over`() {
        val gate = UploadGate(maxTotal = 10, maxPerUser = 2)
        repeat(100) { gate.permit(UUID.randomUUID()).close() }

        assertEquals(0, gate.inFlight.value)
        assertEquals(0, gate.usersTracked, "a long-running server must not grow a table of everybody who ever uploaded")
    }

    @Test
    fun `the count is observable, so that a test can wait for an event instead of a time`() = runBlocking<Unit> {
        val gate = UploadGate(maxTotal = 10, maxPerUser = 2)
        val permit = gate.permit(alice)

        withTimeout(5_000) { gate.inFlight.first { it == 1 } }
        permit.close()
        withTimeout(5_000) { gate.inFlight.first { it == 0 } }
    }

    @Test
    fun `many threads at once never get more than either limit allows, and give everything back`() {
        val gate = UploadGate(maxTotal = 6, maxPerUser = 2)
        val users = List(5) { UUID.randomUUID() }
        val activeTotal = AtomicInteger()
        val maxTotalSeen = AtomicInteger()
        val activePerUser = users.associateWith { AtomicInteger() }
        val maxPerUserSeen = AtomicInteger()
        val granted = AtomicInteger()
        val refused = AtomicInteger()
        val start = CountDownLatch(1)

        val threads = List(40) { n ->
            val user = users[n % users.size]
            thread {
                start.await()
                repeat(500) {
                    when (val admission = gate.tryAcquire(user)) {
                        is UploadGate.Permit -> {
                            granted.incrementAndGet()
                            maxTotalSeen.accumulateAndGet(activeTotal.incrementAndGet(), ::maxOf)
                            maxPerUserSeen.accumulateAndGet(activePerUser.getValue(user).incrementAndGet(), ::maxOf)
                            Thread.onSpinWait()
                            activePerUser.getValue(user).decrementAndGet()
                            activeTotal.decrementAndGet()
                            admission.close()
                        }
                        else -> refused.incrementAndGet()
                    }
                }
            }
        }
        start.countDown()
        threads.forEach { it.join(60_000) }

        assertTrue(maxTotalSeen.get() <= 6, "never more than 6 bodies in flight, saw ${maxTotalSeen.get()}")
        assertTrue(maxPerUserSeen.get() <= 2, "never more than 2 per user, saw ${maxPerUserSeen.get()}")
        assertTrue(granted.get() > 0 && refused.get() > 0, "the test must really contend: granted ${granted.get()}, refused ${refused.get()}")
        assertEquals(0, gate.inFlight.value)
        assertEquals(0, gate.usersTracked)
        assertTrue(threads.none { it.isAlive }, "every thread finished")
        assertEquals(40 * 500, granted.get() + refused.get())
    }
}
