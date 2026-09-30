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
}
