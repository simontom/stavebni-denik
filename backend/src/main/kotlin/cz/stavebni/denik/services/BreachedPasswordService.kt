package cz.stavebni.denik.services

import cz.stavebni.denik.config.AppConfig
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import org.slf4j.LoggerFactory
import java.security.MessageDigest

/**
 * Asks the Pwned Passwords service whether a password has appeared in a known data breach.
 *
 * Only the first five hex characters of the password's SHA-1 leave the server (the "range" API,
 * k-anonymity): the service answers with every hash suffix that shares them and the match is made here.
 * The password itself is never sent, and the answer cannot be used to recover it.
 *
 * The check is a nicety, not a gate: if the service cannot be reached, is slow or answers nonsense, the
 * password is accepted (fail open) and a warning is logged, so a third party's outage never stops a user
 * from changing a password.
 */
object BreachedPasswordService {
    private val log = LoggerFactory.getLogger(BreachedPasswordService::class.java)

    /** Range endpoint, or null when the check is switched off (see `PWNED_PASSWORDS_URL`). */
    var baseUrl: String? = AppConfig.pwnedPasswordsUrl

    var client: HttpClient = HttpClient(CIO) {
        install(HttpTimeout) {
            connectTimeoutMillis = 1_000
            requestTimeoutMillis = 2_000
        }
    }

    suspend fun isBreached(password: String): Boolean {
        val base = baseUrl ?: return false
        val sha1 = sha1Hex(password)
        val prefix = sha1.substring(0, 5)
        val suffix = sha1.substring(5)
        return try {
            val body = client.get("${base.trimEnd('/')}/$prefix") {
                // Pads the answer with fake entries so its size does not hint at the prefix.
                header("Add-Padding", "true")
            }.bodyAsText()
            body.lineSequence().any { line ->
                val (candidate, count) = line.trim().split(':', limit = 2).let { it[0] to it.getOrNull(1) }
                // Padding entries have a count of 0 and are not real matches.
                candidate.equals(suffix, ignoreCase = true) && (count?.trim()?.toLongOrNull() ?: 0L) > 0L
            }
        } catch (e: Exception) {
            log.warn("Breached-password check skipped: {}", e.javaClass.simpleName)
            false
        }
    }

    private fun sha1Hex(password: String): String =
        MessageDigest.getInstance("SHA-1").digest(password.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02X".format(it) }
}
