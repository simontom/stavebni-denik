package cz.stavebni.denik.services

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Bounds the uploads that are in flight, in two stages, so that the people who may not upload cannot use up the places of
 * those who may.
 *
 * - **An upload in progress, per user** ([tryEnter], at most [maxPerUser]): taken as soon as the request arrives, before
 *   anything of its body is read. It costs the server little (the engine hands over a few KiB of a body at a time, and the
 *   fields at the start of an upload are read with a tiny limit), so every signed-in account may hold a couple, whoever
 *   they are; and it stops one account from flooding.
 * - **A body in memory, for the whole server** ([tryTakeBody], at most [maxBodies]): taken only once the upload has been
 *   *authorised*, when its file part arrives and the person is known to be allowed to add a photo to that entry. This is the
 *   one that counts memory: up to 5 MiB of the file are held (and twice that for a moment) until the photo is stored.
 *   A stranger, an investor or an inspector never gets one, so they cannot fill the places of the people who work on site,
 *   however slowly they send.
 *
 * It lives in this process on purpose: it protects this process's heap (a database counter would outlive a crash and would not
 * follow the memory). A permit is given back by [Permit.close], which the caller must reach on every way out of the request
 * (use `permit.use { ... }`): a normal end, an error, a client that went away, a timeout. A permit that is never closed is a
 * self-inflicted denial of service.
 */
class UploadGate(val maxBodies: Int, val maxPerUser: Int) {

    /** One place. [close] gives it back; closing twice gives back one. */
    class Permit internal constructor(private val onClose: () -> Unit) : AutoCloseable {
        private val open = AtomicBoolean(true)
        override fun close() {
            if (open.compareAndSet(true, false)) onClose()
        }
    }

    private val lock = Any()
    private var bodiesTaken = 0
    private var entered = 0
    private val perUser = HashMap<UUID, Int>()
    private val bodiesFlow = MutableStateFlow(0)
    private val enteredFlow = MutableStateFlow(0)

    /** Uploads in progress (the first stage), observable so that a test (or a metric) can wait for an event instead of a time. */
    val uploads: StateFlow<Int> get() = enteredFlow

    /** Bodies held in memory (the second stage), observable in the same way. */
    val bodies: StateFlow<Int> get() = bodiesFlow

    /** How many users have an upload in progress; a user with none is not remembered. */
    val usersTracked: Int get() = synchronized(lock) { perUser.size }

    fun uploadsOf(user: UUID): Int = synchronized(lock) { perUser[user] ?: 0 }

    /** The first stage. `null` when [user] already has [maxPerUser] uploads in progress. Never blocks and never reads anything. */
    fun tryEnter(user: UUID): Permit? = synchronized(lock) {
        val mine = perUser[user] ?: 0
        if (mine >= maxPerUser) return null
        perUser[user] = mine + 1
        entered++
        enteredFlow.value = entered
        Permit { leave(user) }
    }

    /** The second stage. `null` when [maxBodies] bodies are held already. Call it only for an upload that has been authorised. */
    fun tryTakeBody(): Permit? = synchronized(lock) {
        if (bodiesTaken >= maxBodies) return null
        bodiesTaken++
        bodiesFlow.value = bodiesTaken
        Permit { dropBody() }
    }

    private fun leave(user: UUID) {
        synchronized(lock) {
            val mine = perUser[user] ?: return
            if (mine <= 1) perUser.remove(user) else perUser[user] = mine - 1
            entered--
            enteredFlow.value = entered
        }
    }

    private fun dropBody() {
        synchronized(lock) {
            bodiesTaken--
            bodiesFlow.value = bodiesTaken
        }
    }
}

/**
 * The numbers for uploads, in one place. Change them here (and in `PROJECT.md`, "Request and upload limits").
 *
 * What a body costs once it is authorised: the file is read into a buffer of up to 5 MiB, which is then copied into the array
 * that is kept (so up to 10 MiB for a moment, 5 MiB after), plus about 1 MiB in the channels in front of it. Say 11 MiB each:
 * 8 bodies are 88 MiB. The two images in process add about 50 to 80 MiB each (the decoded picture, the turned copy, the
 * resized one, the encoder), so about 160 MiB at most. That is roughly 250 MiB of the 400 MiB heap of the 1 GB machine, and
 * about 150 MiB are left for everything else. These are estimates from the code, not a load test. The machine is the reference
 * (`fly.toml`); the gate is a fixed number, so a bigger machine is simply not used to the full.
 */
object UploadLimits {
    /** Bodies held in memory, in the whole server (the second stage of [UploadGate]). */
    const val BODIES_IN_FLIGHT = 8

    /** Uploads in progress per user (the first stage). The SPA sends one at a time; a second one is a retry or a second tab. */
    const val UPLOADS_PER_USER = 2

    /** What a refused client is told to wait, in seconds (`Retry-After`): a photo takes a few seconds to arrive. */
    const val RETRY_AFTER_SECONDS = 5L

    /**
     * How long an upload may take to show what it is for: from the request to the file part, with the fields before it that
     * name the entry. They are a few hundred bytes, so a client that is merely slow gets them in a second; one that sends
     * nothing for this long holds a first-stage place for nothing and is answered `408`.
     */
    @Volatile
    var preFileTimeout: Duration = Duration.ofSeconds(30)

    /**
     * How long the whole upload may take, from the request to the last byte of the file. The engine already drops a
     * connection that sends nothing for 60 s, but a client that sends a byte a minute would hold its permit for ever.
     * 10 minutes allow 5 MiB at about 70 kbit/s, which is slower than any phone connection a site has. The memory place is
     * only taken by people who may upload, and a user has two of them at most.
     */
    @Volatile
    var bodyTimeout: Duration = Duration.ofMinutes(10)

    /** The gate itself. A variable only so that tests can use small numbers. */
    @Volatile
    internal var gate: UploadGate = UploadGate(BODIES_IN_FLIGHT, UPLOADS_PER_USER)
}
