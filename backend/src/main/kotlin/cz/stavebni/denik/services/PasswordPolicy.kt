package cz.stavebni.denik.services

import java.text.Normalizer

/**
 * What a password chosen by a user has to look like. The same rules are shown by the
 * change-password form; the server is what enforces them.
 */
object PasswordPolicy {
    const val MIN_LENGTH = 12

    /** Also bounds the work Argon2 does for one request. */
    const val MAX_LENGTH = 256

    /** A login name shorter than this is not looked for in a password: it would match half of all passwords. */
    const val MIN_NICKNAME_LENGTH_CHECKED = 3

    /**
     * Base words (letters only, lower case, no diacritics) refused whatever digits and symbols are wrapped
     * around them: `Heslo123456!` and `P@ssw0rd!2024` pass every character-class rule and are among the first
     * things anybody tries. A short offline first line; the breached-password check covers the long tail, but
     * it lets everything through when that service is unreachable.
     */
    private val COMMON_BASE_WORDS: Set<String> = setOf(
        "password", "passwrd", "psswrd", "heslo", "hesloheslo",
        "qwerty", "qwertz", "qwertyuiop", "qwertzuiop", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm",
        "abcdefgh", "abcdefghijkl",
        "admin", "administrator", "letmein", "welcome", "iloveyou", "monkey", "dragon", "master", "login",
        "secret", "changeme",
        "stavba", "stavebni", "stavebnidenik", "denik", "bagr",
        "ceskarepublika", "cesko", "praha", "brno", "ostrava", "sparta", "slavia", "fotbal", "hokej",
        "miluji", "miluju", "jaro", "leto", "podzim", "zima",
    )

    /** Lower case, no diacritics, only a-z. */
    private fun lettersOnly(value: String): String =
        Normalizer.normalize(value, Normalizer.Form.NFD)
            .lowercase()
            .filter { it in 'a'..'z' }

    /** True when the password is nothing but a common word with digits and symbols around it. */
    fun isCommon(password: String): Boolean = lettersOnly(password) in COMMON_BASE_WORDS

    private fun containsNickname(password: String, nickname: String?): Boolean {
        val name = nickname?.trim().orEmpty()
        return name.length >= MIN_NICKNAME_LENGTH_CHECKED && password.lowercase().contains(name.lowercase())
    }

    /**
     * Czech messages, one per rule that is not met; empty when the password is acceptable.
     * [nickname] is the login name of the account the password is for, when it is known.
     */
    fun issues(password: String, nickname: String? = null): List<String> = buildList {
        if (password.length < MIN_LENGTH) add("Heslo musí mít alespoň $MIN_LENGTH znaků.")
        if (password.length > MAX_LENGTH) add("Heslo může mít nejvýše $MAX_LENGTH znaků.")
        if (password.none { it in 'a'..'z' }) add("Heslo musí obsahovat alespoň jedno malé písmeno.")
        if (password.none { it in 'A'..'Z' }) add("Heslo musí obsahovat alespoň jedno velké písmeno.")
        if (password.none { it in '0'..'9' }) add("Heslo musí obsahovat alespoň jednu číslici.")
        if (password.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' }) add("Heslo musí obsahovat alespoň jeden speciální znak.")
        if (isCommon(password)) add("Heslo je příliš běžné a snadno uhodnutelné.")
        if (containsNickname(password, nickname)) add("Heslo nesmí obsahovat vaše přihlašovací jméno.")
    }
}
