package cz.stavebni.denik.services

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Bounds how many upload bodies are **in flight** at the same time: for each user, and for the server as a whole.
 *
 * Why: the body of an upload (up to 5 MiB) is held in memory from the first byte until the photo is stored, and the heap
 * is a fraction of a small machine. Without a bound, a few dozen parallel uploads from any signed-in account (an investor's
 * included) exhaust it and the process is restarted. A time window cannot bound that, so this counts *concurrent* bodies.
 *
 * It lives in this process on purpose: it protects this process's heap (a database counter would outlive a crash and
 * would not follow the memory). A permit is taken **before** the first byte of the body is read and is given back by
 * [Permit.close], which the caller must reach on every way out of the request (use `permit.use { ... }`): a normal end,
 * an error, a client that went away, a timeout. A permit that is never closed is a self-inflicted denial of service.
 */
class UploadGate(val maxTotal: Int, val maxPerUser: Int) {

    /** The answer of [tryAcquire]: a [Permit], or a [Refusal] that says whose limit was reached. */
    sealed interface Admission

    /** One body in flight. [close] gives it back; closing twice gives back one. */
    class Permit internal constructor(private val gate: UploadGate, private val user: UUID) : Admission, AutoCloseable {
        private val open = AtomicBoolean(true)
        override fun close() {
            if (open.compareAndSet(true, false)) gate.release(user)
        }
    }

    enum class Refusal : Admission {
        /** The user already has [maxPerUser] bodies in flight: their own limit, for them to wait. */
        USER_BUSY,

        /** [maxTotal] bodies are in flight for everybody: the server is busy. */
        SERVER_BUSY,
    }

    private val lock = Any()
    private var total = 0
    private val perUser = HashMap<UUID, Int>()
    private val count = MutableStateFlow(0)

    /** The number of bodies in flight, observable so that a test (or a metric) can wait for an event instead of a time. */
    val inFlight: StateFlow<Int> get() = count

    /** How many users have a body in flight; a user with none is not remembered. */
    val usersTracked: Int get() = synchronized(lock) { perUser.size }

    fun inFlightOf(user: UUID): Int = synchronized(lock) { perUser[user] ?: 0 }

    /** Never blocks and never reads anything: the answer is immediate, so a refused request costs the server nothing. */
    fun tryAcquire(user: UUID): Admission = synchronized(lock) {
        val mine = perUser[user] ?: 0
        when {
            mine >= maxPerUser -> Refusal.USER_BUSY
            total >= maxTotal -> Refusal.SERVER_BUSY
            else -> {
                perUser[user] = mine + 1
                total++
                count.value = total
                Permit(this, user)
            }
        }
    }

    private fun release(user: UUID) {
        synchronized(lock) {
            val mine = perUser[user] ?: return
            if (mine <= 1) perUser.remove(user) else perUser[user] = mine - 1
            total--
            count.value = total
        }
    }
}

/**
 * The numbers for uploads, in one place. Change them here (and in `PROJECT.md`, "Request and upload limits").
 *
 * What a body costs: up to 5 MiB held while it is read (about twice that for a moment, while the buffer is copied), plus an
 * image in progress for the [PhotoService.IMAGE_SLOTS] uploads that are being processed (about 80 MB each at most). Eight
 * bodies and two images fit the 400 MB heap of the 1 GB machine with room to spare. A 1 GB machine is the reference
 * (`fly.toml`); the gate is a fixed number, so a bigger machine is simply not used to the full.
 */
object UploadLimits {
    /** Upload bodies in flight in the whole server. */
    const val BODIES_IN_FLIGHT = 8

    /** Upload bodies in flight per user (the SPA sends one at a time; a second one is a retry or a second tab). */
    const val BODIES_PER_USER = 2

    /** What a refused client is told to wait, in seconds (`Retry-After`): a photo takes a few seconds to arrive. */
    const val RETRY_AFTER_SECONDS = 5L

    /**
     * How long a body may take from the first request byte to the last. The engine already drops a connection that sends
     * nothing for 60 s, but a client that sends a byte a minute would hold its permit for ever. 5 minutes allow 5 MiB at
     * about 140 kbit/s, which is slower than any phone connection a site has.
     */
    @Volatile
    var bodyTimeout: Duration = Duration.ofMinutes(5)

    /** The gate itself. A variable only so that tests can use small numbers. */
    @Volatile
    internal var gate: UploadGate = UploadGate(BODIES_IN_FLIGHT, BODIES_PER_USER)
}
