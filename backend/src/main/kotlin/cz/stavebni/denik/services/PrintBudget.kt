package cz.stavebni.denik.services

import cz.stavebni.denik.util.Text

/**
 * How much text one part of the printed document may hold, counted in **printed lines** (backlog B9, review).
 *
 * The characters of a text are limited, but a newline is one character, and a text that is only newlines is thousands of printed lines:
 * measured with the real typst, five thousand of them are about a hundred pages, and a few hundred thousand (what the size of a request
 * allows for a field that has no limit of its own) are thousands of pages, several seconds and hundreds of megabytes. The PDF of an entry is
 * rendered on a machine with 1 GB and two renders run at the same time, so one entry (or one project, whose protocols every entry prints)
 * with such a text would make **every** PDF of it fail. The limits at the time of saving (`SiteHandoverService.MAX_PARTICIPANTS_LINES`
 * and the others) are the first defence; this is the second, for what is stored already and for every field that has no limit of lines.
 *
 * A budget is a number of lines. [take] cuts a text to what is left of it (and to a cap of its own) and says how many lines it left out:
 * **what is cut is never cut silently**, the caller prints [omittedNote] where the text was cut. The unit is an estimate (a line is a line
 * of text that ends with a break, and a long one counts as several, for the width of the place it is printed in), made so that it is
 * never much less than the real number of lines: the pages that result are measured in `RealTypstHandoversPdfTest`.
 */
internal class PrintBudget(lines: Int) {

    /** What is left of the budget. */
    var left: Int = lines
        private set

    /** [text] as far as it fits, and how many lines were left out (zero when it fits whole). */
    class Fitted(val text: String, val omitted: Int) {
        /**
         * What the document prints in the place of the text: the text, or an ellipsis when there was something and none of it fits (an
         * empty place would be printed as "bez záznamu", which a text that was cut away is not).
         */
        val shown: String get() = if (text.isEmpty() && omitted > 0) "…" else text
    }

    /**
     * [text] cut to at most [cap] lines and to what is left of the budget; what it takes is spent. A line is counted as one line for each
     * [charsPerLine] characters of it (an empty line is one). A cut is made at the end of a line, and inside a line when even one line does
     * not fit.
     */
    fun take(text: String, charsPerLine: Int, cap: Int = Int.MAX_VALUE): Fitted {
        // Nothing is nothing: it costs no line and is never "cut" (the place it stands in is paid for by whoever prints the place).
        if (text.isEmpty()) return Fitted("", 0)
        val allowed = minOf(cap, left)
        val total = linesOf(text, charsPerLine)
        if (total <= allowed) {
            left -= total
            return Fitted(text, 0)
        }
        var used = 0
        var end = 0
        var start = 0
        val breaks = Text.lineBreaks(text).iterator()
        while (true) {
            val lineBreak = if (breaks.hasNext()) breaks.next() else null
            val lineEnd = lineBreak?.range?.first ?: text.length
            val cost = lineCost(text.codePointCount(start, lineEnd), charsPerLine)
            if (used + cost > allowed) {
                val room = allowed - used
                if (room > 0) {
                    // Not even one whole line fits: as many characters of it as the room holds.
                    end = text.offsetByCodePoints(start, minOf(text.codePointCount(start, lineEnd), room * charsPerLine))
                    used += room
                }
                break
            }
            used += cost
            end = lineEnd
            if (lineBreak == null) break
            start = lineBreak.range.last + 1
        }
        left -= used
        return Fitted(text.substring(0, end), total - used)
    }

    /** A row of a table: its [cells] are side by side, so it is as tall as its tallest cell (each cell cut to [cap] lines). */
    class Row(val cells: List<String>, val cost: Int, val omitted: Int)

    /** The row [cells] if it fits what is left (and spends its height), otherwise null and nothing is spent. */
    fun row(cells: List<String>, charsPerLine: Int, cap: Int): Row? {
        val fitted = cells.map { cell -> PrintBudget(cap).take(cell, charsPerLine) }
        val cost = fitted.maxOf { linesOf(it.text, charsPerLine) }
        if (cost > left) return null
        left -= cost
        return Row(fitted.map { it.text }, cost, fitted.sumOf { it.omitted })
    }

    /** Spends [lines] (the fixed part of something that is printed, such as a heading and a block of signatures) if they are left; otherwise nothing, and false. */
    fun spend(lines: Int): Boolean {
        if (lines > left) return false
        left -= lines
        return true
    }

    companion object {
        private fun lineCost(characters: Int, charsPerLine: Int): Int = maxOf(1, (characters + charsPerLine - 1) / charsPerLine)

        /** How many printed lines [text] is, for a place that holds [charsPerLine] characters of a line. */
        fun linesOf(text: String, charsPerLine: Int): Int {
            var total = 0
            var start = 0
            for (lineBreak in Text.lineBreaks(text)) {
                total += lineCost(text.codePointCount(start, lineBreak.range.first), charsPerLine)
                start = lineBreak.range.last + 1
            }
            return total + lineCost(text.codePointCount(start, text.length), charsPerLine)
        }

        private fun form(count: Int, one: String, few: String, many: String): String = when {
            count == 1 -> one
            count in 2..4 -> few
            else -> many
        }

        /**
         * The sentence that says something was left out ("… a dalších 12 řádků se do tohoto výtisku nevešlo; úplné znění je v aplikaci."), in
         * the Czech form that goes with the number; empty when nothing was. [one], [few] and [many] are the noun for 1, for 2 to 4 and for 5 or
         * more (all of them masculine inanimate: `řádek`, `protokol`, `záznam`).
         */
        fun omittedNote(count: Int, one: String, few: String, many: String): String = when {
            count <= 0 -> ""
            count == 1 -> "… a další 1 $one se do tohoto výtisku nevešel; úplné znění je v aplikaci."
            else -> "… a ${form(count, "další", "další", "dalších")} $count ${form(count, one, few, many)} se do tohoto výtisku ${form(count, "nevešel", "nevešly", "nevešlo")}; úplné znění je v aplikaci."
        }

        fun omittedLines(count: Int): String = omittedNote(count, "řádek", "řádky", "řádků")
        fun omittedProtocols(count: Int): String = omittedNote(count, "protokol", "protokoly", "protokolů")
        fun omittedRecords(count: Int): String = omittedNote(count, "záznam", "záznamy", "záznamů")
    }
}
