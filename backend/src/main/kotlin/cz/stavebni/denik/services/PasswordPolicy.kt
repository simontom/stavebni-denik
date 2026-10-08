package cz.stavebni.denik.services

/**
 * What a password chosen by a user has to look like. The same rules are shown by the
 * change-password form; the server is what enforces them.
 */
object PasswordPolicy {
    const val MIN_LENGTH = 12

    /** Also bounds the work Argon2 does for one request. */
    const val MAX_LENGTH = 256

    /** Czech messages, one per rule that is not met; empty when the password is acceptable. */
    fun issues(password: String): List<String> = buildList {
        if (password.length < MIN_LENGTH) add("Heslo musí mít alespoň $MIN_LENGTH znaků.")
        if (password.length > MAX_LENGTH) add("Heslo může mít nejvýše $MAX_LENGTH znaků.")
        if (password.none { it in 'a'..'z' }) add("Heslo musí obsahovat alespoň jedno malé písmeno.")
        if (password.none { it in 'A'..'Z' }) add("Heslo musí obsahovat alespoň jedno velké písmeno.")
        if (password.none { it in '0'..'9' }) add("Heslo musí obsahovat alespoň jednu číslici.")
        if (password.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' }) add("Heslo musí obsahovat alespoň jeden speciální znak.")
    }
}
