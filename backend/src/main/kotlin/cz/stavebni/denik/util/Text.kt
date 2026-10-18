package cz.stavebni.denik.util

/** Checks of text a person enters, shared by the services: a problem is an [IllegalArgumentException], which the API answers with 400. */
object Text {
    /**
     * [text] if it is at most [max] characters and holds no NUL character (PostgreSQL cannot store one in text: saying so here
     * is a 400 with a message, not an error from the database). [what] names the field in the message.
     *
     * Characters are counted as a person counts them (Unicode code points): an emoji is one character, not the two UTF-16 code
     * units that `String.length` would say, so the limit in the message ("znaků") is the limit that is applied.
     */
    fun checked(text: String, what: String, max: Int): String {
        require(text.codePointCount(0, text.length) <= max) { "$what může mít nejvýše $max znaků" }
        require(!text.contains('\u0000')) { "$what obsahuje nepovolený znak (NUL)" }
        return text
    }
}
