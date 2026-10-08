package cz.stavebni.denik.services

import de.mkammerer.argon2.Argon2Factory

object PasswordService {
    private val argon2 = Argon2Factory.create(Argon2Factory.Argon2Types.ARGON2id)

    fun hash(password: String): String {
        return argon2.hash(2, 65536, 1, password.toCharArray())
    }

    fun verify(hash: String, password: String): Boolean {
        return argon2.verify(hash, password.toCharArray())
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
