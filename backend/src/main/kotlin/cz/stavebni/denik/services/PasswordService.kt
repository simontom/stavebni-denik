package cz.stavebni.denik.services

import de.mkammerer.argon2.Argon2Factory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.util.UUID

object PasswordService {
    private val argon2 = Argon2Factory.create(Argon2Factory.Argon2Types.ARGON2id)

    /** One Argon2 run uses 64 MiB of native memory; never more than a few at the same time. */
    private val gate = Semaphore(4)

    /** A hash nobody knows the password of: checking against it costs the same as checking a real one. */
    private val unknownUserHash: String by lazy { hash(UUID.randomUUID().toString()) }

    fun hash(password: String): String {
        return argon2.hash(2, 65536, 1, password.toCharArray())
    }

    fun verify(hash: String, password: String): Boolean {
        return argon2.verify(hash, password.toCharArray())
    }

    /** [hash] for request handlers: off the event loop, with bounded concurrency. */
    suspend fun hashAsync(password: String): String = gate.withPermit { withContext(Dispatchers.IO) { hash(password) } }

    /** [verify] for request handlers: off the event loop, with bounded concurrency. */
    suspend fun verifyAsync(hash: String, password: String): Boolean =
        gate.withPermit { withContext(Dispatchers.IO) { verify(hash, password) } }

    /**
     * Spends the time of a password check for an account that does not exist or may not log in, so the
     * response time does not reveal whether a name is known. Always returns false.
     */
    suspend fun verifyAgainstNobody(password: String): Boolean {
        verifyAsync(unknownUserHash, password)
        return false
    }

    private val selfTested: Unit by lazy {
        val probe = "startup-self-test"
        check(verify(hash(probe), probe)) { "Argon2 self-test failed: a hash did not verify" }
    }

    /**
     * Hashes and verifies a throwaway password, once per JVM.
     *
     * argon2-jvm calls a native library through JNA. If that library cannot work in the current
     * environment, the process must fail when it starts, not when the first account is created: on
     * Alpine (musl libc) the JVM dies with SIGSEGV as soon as a password is hashed, while verifying
     * one still works, so the problem stays invisible until an admin creates a user.
     */
    fun ensureWorks() = selfTested
}
