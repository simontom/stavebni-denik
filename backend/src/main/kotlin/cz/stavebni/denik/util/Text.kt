package cz.stavebni.denik.util

/** Checks of text a person enters, shared by the services: a problem is an [IllegalArgumentException], which the API answers with 400. */
object Text {
    /**
     * [text] if it is at most [max] characters and holds no NUL character (PostgreSQL cannot store one in text: saying so here
     * is a 400 with a message, not an error from the database). [what] names the field in the message.
     */
    fun checked(text: String, what: String, max: Int): String {
        require(text.length <= max) { "$what může mít nejvýše $max znaků" }
        require(!text.contains('\u0000')) { "$what obsahuje nepovolený znak (NUL)" }
        return text
    }
}
