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

    /**
     * What ends a line in the printed document: a line feed, a carriage return, or both together (one break), and the characters that the
     * layout engine ends a line at as well (vertical tab, form feed, next line, the line and paragraph separators of Unicode). One
     * definition for the limits of the lines that people enter and for the budget of lines that a document prints, so that a text cannot
     * be a few lines for the one and many for the other.
     */
    private val LINE_BREAK = Regex("\r\n|[\r\n\u000B\u000C\u0085  ]")

    /** The lines of [text] (an empty text is one empty line); a break at the very end makes an empty last line. */
    fun lines(text: String): List<String> = text.split(LINE_BREAK)

    /** How many lines [text] has: one more than its breaks, a CRLF being one. */
    fun lineCount(text: String): Int = LINE_BREAK.findAll(text).count() + 1

    /** The breaks that end the lines of [text], in order: where it can be cut without cutting a line. */
    internal fun lineBreaks(text: String): Sequence<MatchResult> = LINE_BREAK.findAll(text)

    /** [text] if it is one line; a problem is a 400 that names the field (a name, a type, a number: nothing that is written over several lines). */
    fun singleLine(text: String, what: String): String {
        require(!LINE_BREAK.containsMatchIn(text)) { "$what musí být na jeden řádek" }
        return text
    }

    /** [text] if it has at most [max] lines; the message names the field and the limit. */
    fun maxLines(text: String, what: String, max: Int): String {
        require(lineCount(text) <= max) { "$what může mít nejvýše $max řádků" }
        return text
    }
}
